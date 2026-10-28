
'use strict';
// OpenAI 兼容 LLM 网关：/v1/chat/completions(流式) + /v1/models
// 转发到小浣熊 LLM base：https://xiaohuanxiong.com/api/web/llm/v2
// 鉴权：完整 Bearer access_token 转发上游（上游只认 Authorization: Bearer <accessToken>）
// 面板侧鉴权：RACCOON_ADMIN_TOKEN / RACCOON_API_TOKEN（未配则本网关需自校验）
const net = require('./net');
const accounts = require('./accounts');
const util = require('./util');

const LLM_BASE = process.env.RACCOON_LLM_BASE || 'https://xiaohuanxiong.com/api/web/llm/v2';

// 上游对未知模型静默回落到默认并返回200——必须在本地校验模型名，防止误用默认额度
const DEFAULT_MODEL = 'raccoon-8c4485';
let _catalog = null;   // 内存缓存模型目录

// ---------- 模型目录解析（严格等价 APK RaccoonModels.parseCatalog / normalizeEntry） ----------

// pickInt：在 entry 主对象与 params 子对象里，按给定的多个候选键名找第一个合法数字（>=0 且非 NaN/Inf）
function _pickInt(entry, params, keys) {
  for (const k of keys) {
    const v = entry ? entry[k] : undefined;
    const n = _toNonNegNum(v);
    if (n !== null) return n;
    if (params) {
      const n2 = _toNonNegNum(params[k]);
      if (n2 !== null) return n2;
    }
  }
  return null;
}
function _toNonNegNum(v) {
  if (v === null || v === undefined) return null;
  let d = null;
  if (typeof v === 'number') d = v;
  else if (typeof v === 'string') { const t = Number(v); if (!Number.isNaN(t)) d = t; }
  if (d === null) return null;
  if (!Number.isFinite(d)) return null;
  return Math.trunc(d);
}

// normalizeEntry：单条模型归一化，字段优先级与 APK 一致
function _normalizeEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  // name 优先，空则用 model_name；两者都空 → 丢弃该条
  let rawName = entry.name;
  if (!rawName || String(rawName).length === 0) rawName = entry.model_name;
  const id = String(rawName == null ? '' : rawName).trim();
  if (!id.length) return null;

  // tags → 数组（去空白）
  const tags = Array.isArray(entry.tags)
    ? entry.tags.map(t => String(t == null ? '' : t).trim()).filter(t => t.length)
    : [];
  // 任一 tag 命中视觉关键词 → 支持图片
  const supportsImages = tags.some(t => t === 'vision' || t === 'image' || t === 'image-understanding');

  const params = (entry.params && typeof entry.params === 'object') ? entry.params : null;

  // 展示名：display_name → description(<=64字符时) → id
  const description = String(entry.description == null ? '' : entry.description).trim();
  let displayName = String(entry.display_name == null ? '' : entry.display_name).trim();
  if (!displayName.length) displayName = (description.length > 0 && description.length <= 64) ? description : id;
  const displayDescription = String(entry.display_description == null ? '' : entry.display_description).trim();

  // 上下文窗口 / 最大输出（兼容 snake_case 与 camelCase，且在主对象或 params 里都找）
  const contextWindow = _pickInt(entry, params, ['context_window', 'contextWindow']);
  const maxTokens = _pickInt(entry, params, ['max_tokens', 'maxTokens']);

  // visible 缺省为 true
  const visible = (typeof entry.visible === 'boolean') ? entry.visible : true;

  return {
    id, name: id, displayName, description,
    displayDescription: displayDescription || description,
    tags, contextWindow, maxTokens,
    supportsImages, supportsReasoning: true,
    credits: '',
  };
}

// parseCatalog：payload → (data 是对象则下钻) → categories[].models[] → normalize + 按 id 去重
function parseCatalog(payload) {
  if (!payload || typeof payload !== 'object') return [];
  let root = payload;
  if (root.data && typeof root.data === 'object' && !Array.isArray(root.data)) root = root.data;
  const cats = Array.isArray(root.categories) ? root.categories : null;
  if (!cats) return [];
  const seen = new Set();
  const out = [];
  for (const c of cats) {
    if (!c || typeof c !== 'object') continue;
    const models = Array.isArray(c.models) ? c.models : null;
    if (!models) continue;
    for (const raw of models) {
      const m = _normalizeEntry(raw);
      if (!m) continue;
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      out.push(m);
    }
  }
  return out;
}

let _catalogErr = null;  // 记住上一次拉取失败的真实原因（供诊断/展柜提示）
async function getCatalog(accountToken) {
  if (_catalog && _catalog.length) return _catalog;  // 空数组是 truthy，必须判 length，否则第一次失败后永久短路
  try {
    const r = await net.request({ base: LLM_BASE, path: '/model_catalog', method: 'GET',
      headers: { 'Authorization': 'Bearer ' + (accountToken||''), 'Accept': 'application/json' },
      timeoutMs: 15000 });
    if (r && r.status !== 200) {
      _catalogErr = { status: r.status, raw: String(r.rawBody||'').slice(0,300) };
      _catalog = []; return _catalog;
    }
    // 严格等价 APK RaccoonModels.parseCatalog + normalizeEntry：
    //   payload → 若有 data 且是对象则下钻 → categories[] → 每项.models[] → 逐条 normalize，按 id 去重
    _catalog = parseCatalog(r && r.data);
    if (!_catalog.length) _catalogErr = { status: r && r.status, note: 'parsed-empty', raw: String((r && r.rawBody)||'').slice(0,300) };
    return _catalog;
  } catch (e) { _catalogErr = { catch: String((e && e.message) || e).slice(0,300) }; _catalog = []; return _catalog; }
}

// 账号鉴权中间件：请求带 ?account=<uid> 或 ?ak=<apiKey> 选中账号，返回该账号 accessToken
// 简化：用面板 token（x-account-token 头）或 ?account= 指定账号 uid；默认第一个可用账号
async function resolveAccount(ctx) {
  const accList = await accounts.listAccounts();
  const live = (accList||[]).filter(a => !a._del && a.accessToken);
  if (!live.length) return { error: '无可用账号，请先 /login 添加' };

  const qAccount = ctx.query && ctx.query.account;
  let acc = null;
  if (qAccount) {
    acc = live.find(a => String(a.UserID || a.uid) === String(qAccount));
    if (!acc) return { error: '找不到指定账号: ' + qAccount };
  } else {
    acc = live[0];   // 默认第一个账号
  }
  return { acc };
}

// POST /v1/chat/completions
async function chat(ctx) {
  // 入口 makeCtx 已把 body 流读尽并解析到 ctx.rawBody/ctx.body —— 绝不能再对同一 req 二次 readBody，
  // 否则 data/end 不会再触发，Promise 永远不 resolve → 请求挂起 → 客户端收 000。
  const bodyRaw = ctx.rawBody || '';
  let body = ctx.body && typeof ctx.body === 'object' ? ctx.body : null;
  if (!body) { try { body = JSON.parse(bodyRaw || '{}'); } catch(e) { return util.json(ctx.res, 400, { error: { message: '请求体不是合法 JSON' } }); } }

  // 选账号
  const accR = await resolveAccount(ctx);
  if (accR.error) return util.json(ctx.res, 400, { error: { message: accR.error } });
  const acc = accR.acc;
  const token = acc.accessToken;

  // 模型名校验：只在已有缓存目录时比对，绝不阻塞对话主链路。
  // （getCatalog 会拉上游目录，若在对话前阻塞可能秒级挂起；diag-llm 不走它所以 200。
  //   改为有缓存就用缓存比对，没缓存直接放行透明代理，让上游决定。）
  if (body.model && Array.isArray(_catalog) && _catalog.length) {
    const known = _catalog.some(m => (m.model_name && m.model_name === body.model) || (m.id && m.id === body.model));
    if (!known && body.model !== DEFAULT_MODEL) {
      // 记录但不拦截（透明代理）
    }
  }

  const stream = body.stream === true;
  const path = '/chat/completions';

  if (stream) {
    // Vercel serverless 不能保持 up.res.pipe(ctx.res) 长连接（实例冻结会被掐断/000），
    // 改为用 net.request 收集上游完整 SSE 响应文本，一次性 setHeader+end 出去。
    // SSE 本身就是纯文本 event stream，客户端解析器拿到完整 body 一样能逐条消费。
    try {
      const up = await net.request({
        base: LLM_BASE, path, method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: bodyRaw, timeoutMs: 90000,
      });
      ctx.res.statusCode = up.status || 200;
      ctx.res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      for (const k of ['cache-control']) if (up.headers && up.headers[k]) ctx.res.setHeader(k, up.headers[k]);
      ctx.res.setHeader('x-account', String(acc.UserID || acc.uid || ''));
      ctx.res.setHeader('x-accel-buffering', 'no');
      return ctx.res.end(up.rawBody || (up.data && JSON.stringify(up.data)) || '');
    } catch (e) {
      return util.json(ctx.res, 502, { error: { message: '上游错误(流式): ' + e.message } });
    }
  }

  // 非流式
  try {
    const up = await net.request({
      base: LLM_BASE, path, method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: bodyRaw, timeoutMs: 60000,
    });
    ctx.res.statusCode = up.status || 200;
    for (const k of ['content-type']) if (up.headers[k]) ctx.res.setHeader(k, up.headers[k]);
    ctx.res.setHeader('x-account', String(acc.UserID || acc.uid || ''));
    return ctx.res.end(up.rawBody || up.data ? JSON.stringify(up.data) : '{}');
  } catch (e) {
    return util.json(ctx.res, 502, { error: { message: '上游错误: ' + e.message } });
  }
}

// GET /v1/models
async function models(ctx) {
  const accR = await resolveAccount(ctx);
  const token = accR.acc ? accR.acc.accessToken : '';
  const cat = await getCatalog(token);
  // getCatalog 归一化后字段是 m.id（值=model_name）；otelOpenAI 客户端认标准 id 字段。
  const data = (cat || []).map(m => ({ id: m.id || m.model_name || m.name, object: 'model', created: 0, owned_by: 'raccoon', contextWindow: m.contextWindow, maxTokens: m.maxTokens }));
  return util.json(ctx.res, 200, { object: 'list', data });
}

// 统一入口 /v1/(chat/completions|completions|models)
async function route(ctx) {
  const m = (ctx.path || '').match(/\/v1\/(?:api\/)?([^/]+(?:\/[^/]+)?)/);
  const kind = m ? m[1] : '';
  const method = (ctx.method || 'GET').toUpperCase();

  // 鉴权：允许外部 API Key（RACCOON_API_TOKEN）或面板管理员 token（RACCOON_ADMIN_TOKEN）
  const adminT = process.env.RACCOON_ADMIN_TOKEN;
  const apiKey  = process.env.RACCOON_API_TOKEN;
  const authTok = (ctx.headers && (ctx.headers['authorization'] || ctx.headers['x-api-key'])) || '';
  const bearer = String(authTok || '').replace(/^Bearer\s+/i, '').trim();
  // 除固定 token 外，也接受 KV 里托管的 Key（keys.isValid 内部含异步镜像与环境变量兼容）
  let kvKeyOk = false;
  try {
    const _k = require('./keys');
    await _k.ensureLoaded();          // 冷启动先拉一次 KV，否则镜像为空会误判
    kvKeyOk = _k.isValid(bearer);
  } catch (_) {}
  const authed = (!adminT && !apiKey) || (adminT && bearer === adminT) || (apiKey && bearer === apiKey) || kvKeyOk;
  if (!authed) return util.json(ctx.res, 401, { error: { message: 'unauthorized' } });

  if (kind === 'chat/completions' || kind === 'completions') {
    if (method !== 'POST') return util.json(ctx.res, 405, { error: { message: 'method not allowed' } });
    return chat(ctx);
  }
  if (kind === 'models') {
    if (method !== 'GET') return util.json(ctx.res, 405, { error: { message: 'method not allowed' } });
    return models(ctx);
  }
  return util.json(ctx.res, 404, { error: { message: 'not found' } });
}

module.exports = {
  route, chat, models, getCatalog, parseCatalog, LLM_BASE,
  get _catalog() { return _catalog; },
  set _catalog(v) { _catalog = v; },
  get _catalogErr() { return _catalogErr; },
};
