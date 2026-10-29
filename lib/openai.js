
'use strict';
// OpenAI 兼容 LLM 网关：/v1/chat/completions(流式) + /v1/models
// 转发到小浣熊 LLM base：https://xiaohuanxiong.com/api/web/llm/v2
// 鉴权：完整 Bearer access_token 转发上游（上游只认 Authorization: Bearer <accessToken>）
// 面板侧鉴权：RACCOON_ADMIN_TOKEN / RACCOON_API_TOKEN（未配则本网关需自校验）
const net = require('./net');
const accounts = require('./accounts');
const util = require('./util');
const stats = require('./stats');
const calls = require('./calls');

const LLM_BASE = process.env.RACCOON_LLM_BASE || 'https://xiaohuanxiong.com/api/web/llm/v2';

// 上游对未知模型静默回落到默认并返回200——必须在本地校验模型名，防止误用默认额度
const DEFAULT_MODEL = 'raccoon-8c4485';
let _catalog = null;   // 内存缓存模型目录

// ---------- 模型目录解析（严格等价 APK RaccoonModels.parseCatalog / normalizeEntry） ----------

// formatMultiplier：对齐 APK RaccoonModels.formatMultiplier
// 四舍五入到 2 位；是整数就输出整数；否则 %.2f 去掉末尾 0 和点
function _formatMultiplier(d) {
  const v = Math.round(d * 100) / 100;
  if (v === Math.floor(v)) return String(Math.trunc(v));
  let t = v.toFixed(2);
  t = t.replace(/0+$/, '').replace(/\.$/, '');
  return t;
}

// credits：billing_effective_multiplier 优先，其次 billing_multiplier；都没有则为空
function _pickCredits(entry) {
  if (!entry || typeof entry !== 'object') return '';
  const num = (x) => {
    if (x === null || x === undefined) return null;
    let d = null;
    if (typeof x === 'number') d = x;
    else if (typeof x === 'string') { const t = Number(x); if (!Number.isNaN(t)) d = t; }
    if (d === null || !Number.isFinite(d) || d < 0) return null;
    return d;
  };
  let m = num(entry.billing_multiplier);
  const eff = num(entry.billing_effective_multiplier);
  if (eff !== null) m = eff;
  if (m === null) return '';
  return 'x' + _formatMultiplier(m) + ' credits';
}

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
    credits: _pickCredits(entry),
    billingMultiplier: (entry.billing_effective_multiplier !== undefined && entry.billing_effective_multiplier !== null) ? entry.billing_effective_multiplier : (entry.billing_multiplier === undefined ? null : entry.billing_multiplier),
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

// 从上游 usage 里提取缓存命中的 prompt token 数。
// 兼容多种字段命名：prompt_tokens_details.cached_tokens（OpenAI/DeepSeek 惯例）、
// cache_read_input_tokens（Anthropic 风格）、cached_tokens 直挂。取不到返回 0。
function _cachedOf(usage) {
  if (!usage || typeof usage !== 'object') return 0;
  const cands = [
    usage.cached_tokens,
    usage.cache_read_input_tokens,
    usage.prompt_cache_hit_tokens,
    usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens,
    usage.prompt_tokens_details && usage.prompt_tokens_details.cache_read_input_tokens,
    usage.input_tokens_details && usage.input_tokens_details.cached_tokens,
  ];
  for (const v of cands) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return Math.round(n);
  }
  return 0;
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
// 智能轮询用的内存游标：同分账号之间轮转，避免并发时全压第一个
let _rrIdx = 0;

// 选账号策略：
//   1) 客户端显式指定 ?account=<uid> 就用它
//   2) 否则在「token 未过期」的账号里，按今日调用量做负载均衡
//      —— 调用数最少优先；调用数相同则失败率低优先；再相同则内存轮转打散。
//   统计走 stats（内存缓存 + KV 落盘），单次开销很小，不会拖慢对话。
async function resolveAccount(ctx) {
  const accList = await accounts.listAccounts();
  const now = Date.now();
  const live = (accList || []).filter(a =>
    !a._del && a.accessToken &&
    !(a.expiryMs && a.expiryMs > 0 && a.expiryMs < now)   // 排除已过期
  );
  if (!live.length) return { error: '无可用账号，请先 /login 添加' };

  const qAccount = ctx.query && ctx.query.account;
  if (qAccount) {
    const acc = live.find(a => String(a.UserID || a.uid) === String(qAccount));
    if (!acc) return { error: '找不到指定账号: ' + qAccount };
    return { acc, pickedBy: 'explicit' };
  }

  // 打分：在途并发数优先（并发请求要分散到不同账号），其次历史调用数，再次失败率
  const scored = [];
  for (const a of live) {
    const uid = String(a.UserID || a.uid || '');
    let load = { calls: 0, failCalls: 0, ms: 0 };
    try { load = await stats.accountLoad(uid); } catch (_) {}
    const failRate = load.calls > 0 ? load.failCalls / load.calls : 0;
    const inf = _inflight[uid];
    const conc = inf ? inf.n : 0;
    // 在途 1 个 = 权重 100000，远超历史调用数差距，保证并发时必然分散
    scored.push({ acc: a, score: conc * 100000 + load.calls * 100 + failRate * 1000 });
  }
  const min = Math.min(...scored.map(x => x.score));
  const cands = scored.filter(x => x.score === min).map(x => x.acc);
  const acc = cands[_rrIdx++ % cands.length] || live[0];
  return { acc, pickedBy: 'balanced', candidates: cands.length };
}

// POST /v1/chat/completions
// ---------- 账号在途请求跟踪（跨实例只能看到本实例，够用：用于显示"使用中"） ----------
const _inflight = Object.create(null);   // uid -> { n: 并发数, lastAt: 最后活动时间, model: 最近模型 }

function beginUse(acc, model) {
  const uid = String((acc && (acc.UserID || acc.uid)) || "");
  if (!uid) return uid;
  const cur = _inflight[uid] || { n: 0, lastAt: 0, model: "" };
  cur.n += 1;
  cur.lastAt = Date.now();
  if (model) cur.model = model;
  _inflight[uid] = cur;
  return uid;
}

function endUse(uid) {
  if (!uid) return;
  const cur = _inflight[uid];
  if (!cur) return;
  cur.n = Math.max(0, cur.n - 1);
  cur.lastAt = Date.now();
  if (cur.n === 0) delete _inflight[uid];
}

// 供 admin/extras 读取
function inflightInfo() {
  const out = {};
  for (const uid of Object.keys(_inflight)) {
    const c = _inflight[uid];
    out[uid] = { n: c.n, lastAt: c.lastAt, model: c.model || "" };
  }
  return out;
}

// 包装：进入时标记"使用中"，退出（无论成功/失败/异常）都清除
async function chat(ctx) {
  try {
    return await chatInner(ctx);
  } finally {
    if (ctx && ctx._useUid) { endUse(ctx._useUid); ctx._useUid = ""; }
  }
}

async function chatInner(ctx) {
  // 入口 makeCtx 已把 body 流读尽并解析到 ctx.rawBody/ctx.body —— 绝不能再对同一 req 二次 readBody，
  // 否则 data/end 不会再触发，Promise 永远不 resolve → 请求挂起 → 客户端收 000。
  const _entryAt = Date.now();
  const bodyRaw = ctx.rawBody || '';
  let body = ctx.body && typeof ctx.body === 'object' ? ctx.body : null;
  if (!body) { try { body = JSON.parse(bodyRaw || '{}'); } catch(e) { return util.json(ctx.res, 400, { error: { message: '请求体不是合法 JSON' } }); } }

  // 选账号
  const accR = await resolveAccount(ctx);
  if (accR.error) return util.json(ctx.res, 400, { error: { message: accR.error } });
  const acc = accR.acc;
  const token = acc.accessToken;
  ctx._useUid = beginUse(acc, body.model || DEFAULT_MODEL);

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
    // 真流式：用 net.requestStream 拿未消费的上游流，边收边写，立刻 flushHeaders。
    // （之前用 net.request 会把整个 SSE 缓冲完再 end，客户端看起来就是一次性输出。）
    const st0 = Date.now();
    try {
      const up = await net.requestStream({
        base: LLM_BASE, path, method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
        body: bodyRaw, timeoutMs: 90000,
      });
      ctx.res.statusCode = up.status || 200;
      ctx.res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      ctx.res.setHeader('Cache-Control', 'no-cache, no-transform');
      ctx.res.setHeader('Connection', 'keep-alive');
      ctx.res.setHeader('X-Accel-Buffering', 'no');
      ctx.res.setHeader('x-account', String(acc.UserID || acc.uid || ''));
      if (typeof ctx.res.flushHeaders === 'function') ctx.res.flushHeaders();

      const decoder = require('string_decoder').StringDecoder;
      const dec = new decoder('utf8');
      let sseBuf = '';   // SSE 文本累加器（改名避免与账号对象 acc 同名遮蔽导致 TDZ）
      let written = 0;

      await new Promise((resolve) => {
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(); } };
        up.res.on('data', (chunk) => {
          sseBuf += dec.write(chunk);
          try { ctx.res.write(chunk); written += chunk.length; } catch (_) { finish(); }
        });
        up.res.on('end', finish);
        up.res.on('error', finish);
        // 客户端断开（用户提前关页面）时别再往死管道写
        ctx.res.on('close', () => { try { up.res.destroy(); } catch (_) {} finish(); });
      });

      try { if (!ctx.res.writableEnded) ctx.res.end(); } catch (_) {}

      // 统计埋点（流式）：从完整 SSE 文本里逐行解析 usage（有嵌套对象，不能用正则抠）
      let sUsage = {};
      try {
        const lines = sseBuf.split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
          const ln = lines[i].trim();
          if (!ln.startsWith('data:')) continue;
          const payload = ln.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const o = JSON.parse(payload);
            if (o && o.usage && (o.usage.total_tokens || o.usage.prompt_tokens || o.usage.completion_tokens)) { sUsage = o.usage; break; }
          } catch (_) {}
        }
        if (!sUsage.total_tokens && !sUsage.prompt_tokens && !sUsage.completion_tokens) {
          let txt = '';
          for (const ln of lines) {
            const t = ln.trim();
            if (!t.startsWith('data:')) continue;
            const payload = t.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            try { const d = JSON.parse(payload); const c = d && d.choices && d.choices[0];
              if (c && c.delta) { if (typeof c.delta.content === 'string') txt += c.delta.content;
                if (typeof c.delta.reasoning_content === 'string') txt += c.delta.reasoning_content; }
            } catch (_) {}
          }
          if (txt.length) {
            const est = Math.max(1, Math.round(txt.length / 1.6));
            sUsage = { completion_tokens: est, prompt_tokens: 0, total_tokens: est, estimated: true };
          }
        }
      } catch (_) {}

      stats.record({
        ok: (up.status || 200) < 400,
        uid: acc.UserID || acc.uid, name: acc.name,
        model: body.model || DEFAULT_MODEL,
        promptTokens: sUsage.prompt_tokens, completionTokens: sUsage.completion_tokens,
        cachedTokens: _cachedOf(sUsage),
        totalTokens: sUsage.total_tokens, ms: Date.now() - st0, stream: true,
        estimated: !!sUsage.estimated,
      }).catch(() => {});
      calls.add({
        ok: (up.status || 200) < 400,
        uid: acc.UserID || acc.uid, name: acc.name,
        model: body.model || DEFAULT_MODEL,
        promptTokens: sUsage.prompt_tokens, completionTokens: sUsage.completion_tokens,
        cachedTokens: _cachedOf(sUsage), totalTokens: sUsage.total_tokens,
        ms: Date.now() - st0, stream: true, estimated: !!sUsage.estimated,
        err: (up.status || 200) >= 400 ? ('HTTP ' + up.status) : '',
      }).catch(() => {});
      return;
    } catch (e) {
      stats.record({ ok: false, uid: acc.UserID || acc.uid, name: acc.name,
        model: body.model || DEFAULT_MODEL, ms: Date.now() - st0, stream: true }).catch(() => {});
      calls.add({ ok: false, uid: acc.UserID || acc.uid, name: acc.name,
        model: body.model || DEFAULT_MODEL, ms: Date.now() - st0, stream: true,
        err: String(e.message || e).slice(0, 160) }).catch(() => {});
      if (ctx.res.headersSent) { try { ctx.res.end(); } catch (_) {} return; }
      return util.json(ctx.res, 502, { error: { message: '上游错误(流式): ' + e.message } });
    }
  }

  // 非流式
  const nt0 = Date.now();
  try { ctx.res.setHeader('x-pre-ms', String(nt0 - _entryAt)); } catch (_) {}
  try {
    const up = await net.request({
      base: LLM_BASE, path, method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: bodyRaw,
      // 按 prompt 体量自适应超时：小上下文 20s 快速失败，大上下文最多 52s
      // （Vercel maxDuration=60s，留 8s 回传余量；超时后返回明确 504 而非被静默掐死）
      timeoutMs: (function(){
        const len = String(bodyRaw || '').length;
        if (len < 50000) return 20000;
        if (len < 200000) return 38000;
        return 52000;
      })(),
    });
    ctx.res.statusCode = up.status || 200;
    for (const k of ['content-type']) if (up.headers[k]) ctx.res.setHeader(k, up.headers[k]);
    ctx.res.setHeader('x-account', String(acc.UserID || acc.uid || ''));
    ctx.res.setHeader('x-upstream-ms', String(Date.now() - nt0));   // 上游真实耗时（诊断用）
    // 统计埋点（非流式）：usage 直接取上游返回
    const nUsage = (up.data && up.data.usage) || {};
    stats.record({
      ok: (up.status || 200) < 400,
      uid: acc.UserID || acc.uid, name: acc.name,
      model: body.model || DEFAULT_MODEL,
      promptTokens: nUsage.prompt_tokens, completionTokens: nUsage.completion_tokens,
      cachedTokens: _cachedOf(nUsage),
      totalTokens: nUsage.total_tokens, ms: Date.now() - nt0, stream: false,
    }).catch(() => {});
    calls.add({
      ok: (up.status || 200) < 400,
      uid: acc.UserID || acc.uid, name: acc.name,
      model: body.model || DEFAULT_MODEL,
      promptTokens: nUsage.prompt_tokens, completionTokens: nUsage.completion_tokens,
      cachedTokens: _cachedOf(nUsage), totalTokens: nUsage.total_tokens,
      ms: Date.now() - nt0, stream: false,
      err: (up.status || 200) >= 400 ? ('HTTP ' + up.status) : '',
    }).catch(() => {});
    return ctx.res.end(up.rawBody || (up.data ? JSON.stringify(up.data) : '{}'));
  } catch (e) {
    stats.record({ ok: false, uid: acc.UserID || acc.uid, name: acc.name,
      model: body.model || DEFAULT_MODEL, ms: Date.now() - nt0, stream: false }).catch(() => {});
    calls.add({ ok: false, uid: acc.UserID || acc.uid, name: acc.name,
      model: body.model || DEFAULT_MODEL, ms: Date.now() - nt0, stream: false,
      err: String(e.message || e).slice(0, 160) }).catch(() => {});
    const isTimeout = /timeout/i.test(String(e && e.message) || '');
    return util.json(ctx.res, isTimeout ? 504 : 502, {
      error: { message: isTimeout ? ('上游生成超时（>48s），大上下文建议用流式(stream:true)') : ('上游错误: ' + e.message) },
    });
  }
}

// GET /v1/models
// POST /v1/completions  —— 旧版 OpenAI Text Completions 兼容层
// 上游只支持 chat 格式（messages），这里把 prompt 转成 messages 转发，
// 再把上游的 chat 响应转回 text_completion 结构，让只认 /v1/completions 的老客户端也能用。
async function legacyCompletions(ctx) {
  const bodyRaw = ctx.rawBody || '';
  let body = ctx.body && typeof ctx.body === 'object' ? ctx.body : null;
  if (!body) { try { body = JSON.parse(bodyRaw || '{}'); } catch (e) { return util.json(ctx.res, 400, { error: { message: '请求体不是合法 JSON' } }); } }

  // prompt 可能是 string 或 string[]，统一取第一个（多 prompt 上游不支持批量）
  let prompt = body.prompt;
  if (Array.isArray(prompt)) prompt = prompt[0];
  prompt = prompt == null ? '' : String(prompt);

  const chatBody = {
    model: body.model || DEFAULT_MODEL,
    messages: [{ role: 'user', content: prompt }],
    stream: false,
  };
  for (const k of ['temperature', 'top_p', 'max_tokens', 'stop', 'presence_penalty', 'frequency_penalty', 'seed', 'user']) {
    if (body[k] !== undefined) chatBody[k] = body[k];
  }

  const accR = await resolveAccount(ctx);
  if (accR.error) return util.json(ctx.res, 400, { error: { message: accR.error } });
  const acc = accR.acc;

  let up;
  try {
    up = await net.request({
      base: LLM_BASE, path: '/chat/completions', method: 'POST',
      headers: { 'Authorization': 'Bearer ' + acc.accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify(chatBody), timeoutMs: 90000,
    });
  } catch (e) {
    return util.json(ctx.res, 502, { error: { message: '上游错误: ' + String(e && e.message) } });
  }
  if (up.status !== 200) {
    return util.json(ctx.res, up.status || 502, up.data || { error: { message: '上游返回 ' + up.status } });
  }

  const d = up.data || {};
  const ch = (d.choices && d.choices[0]) || {};
  const text = (ch.message && ch.message.content) || ch.text || '';
  const usage = d.usage || {};

  return util.json(ctx.res, 200, {
    id: d.id || ('cmpl-' + Date.now().toString(36)),
    object: 'text_completion',
    created: d.created || Math.floor(Date.now() / 1000),
    model: d.model || chatBody.model,
    choices: [{ text, index: 0, logprobs: null, finish_reason: ch.finish_reason || 'stop' }],
    usage: {
      prompt_tokens: usage.prompt_tokens || 0,
      completion_tokens: usage.completion_tokens || 0,
      total_tokens: usage.total_tokens || 0,
    },
  });
}

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

  if (kind === 'chat/completions') {
    if (method !== 'POST') return util.json(ctx.res, 405, { error: { message: 'method not allowed' } });
    return chat(ctx);
  }
  if (kind === 'completions') {
    if (method !== 'POST') return util.json(ctx.res, 405, { error: { message: 'method not allowed' } });
    return legacyCompletions(ctx);
  }
  if (kind === 'models') {
    if (method !== 'GET') return util.json(ctx.res, 405, { error: { message: 'method not allowed' } });
    return models(ctx);
  }
  return util.json(ctx.res, 404, { error: { message: 'not found' } });
}

module.exports = {
  route, chat, legacyCompletions, models, getCatalog, parseCatalog, LLM_BASE,
  get _catalog() { return _catalog; },
  set _catalog(v) { _catalog = v; },
  get _catalogErr() { return _catalogErr; },
  inflightInfo, beginUse, endUse,
};
