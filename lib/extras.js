'use strict';
// 扩展管理 API：设置 / Key 管理 / 模型目录 / 调试 / 日志 / 定时触发
const util = require('./util');
const envstore = require('./envstore');
const keys = require('./keys');
const logs = require('./logs');
const accounts = require('./accounts');
const openai = require('./openai');
const cron = require('./cron');
const net = require('./net');
const checkin = require('./checkin');

const ADMIN_TOKEN = process.env.RACCOON_ADMIN_TOKEN || '';

function authed(ctx) {
  if (!ADMIN_TOKEN) return true;
  const h = (ctx.headers && (ctx.headers['authorization'] || ctx.headers['x-admin-token'])) || '';
  const tok = String(h).replace(/^Bearer\s+/i, '').trim();
  if (tok && tok === ADMIN_TOKEN) return true;
  const q = (ctx.query && (ctx.query.token || ctx.query.key)) || '';
  return q === ADMIN_TOKEN;
}

function mask(v) {
  const s = String(v || '');
  if (!s) return '';
  if (s.length <= 8) return s.slice(0, 2) + '***';
  return s.slice(0, 4) + '...' + s.slice(-4);
}

const SETTING_KEYS = [
  'RACCOON_ADMIN_TOKEN', 'RACCOON_API_TOKEN', 'RACCOON_CRON_SECRET',
  'VERCEL_TOKEN', 'VERCEL_PROJECT_ID', 'VERCEL_TEAM_ID',
  'RACCOON_AUTH_BASE', 'RACCOON_MAIN_ORIGIN', 'RACCOON_LLM_BASE',
  'RACCOON_PLATFORM', 'RACCOON_VERSION',
];
const SECRET_KEYS = new Set(['RACCOON_ADMIN_TOKEN', 'RACCOON_API_TOKEN', 'RACCOON_CRON_SECRET', 'VERCEL_TOKEN']);

async function listModels() {
  // 逐个有 accessToken 的账号试，直到某个能拉出非空目录；失败才 fallback
  try {
    const list = await accounts.listAccounts();
    const live = (list || []).filter(a => a && a.accessToken && !a._del);
    let cat = [];
    for (const acc of live) {
      const got = await openai.getCatalog(acc.accessToken);
      if (Array.isArray(got) && got.length) { cat = got; break; }
    }
    if (Array.isArray(cat) && cat.length) {
      return cat.map(m => ({
        id: m.id || m.model_name, name: m.displayName || m.name || m.model_name || m.id,
        owned_by: 'raccoon',
        description: m.description || m.displayDescription || '',
        tags: Array.isArray(m.tags) ? m.tags : [],
        contextWindow: (m.contextWindow != null ? m.contextWindow : null),
        maxTokens: (m.maxTokens != null ? m.maxTokens : null),
        supportsImages: !!m.supportsImages,
        credits: m.credits || '',
        billingMultiplier: (m.billingMultiplier === undefined ? null : m.billingMultiplier),
      }));
    }
    return [{ id: 'raccoon-8c4485', name: 'raccoon-8c4485', owned_by: 'raccoon',
      fallback: true, _err: openai._catalogErr || null }];
  } catch (e) {
    return [{ id: 'raccoon-8c4485', name: 'raccoon-8c4485', owned_by: 'raccoon',
      fallback: true, _err: { catch: String(e.message || e).slice(0,200) } }];
  }
}

// 非流式调试：真实打一次上游
async function chatDebug(ctx, body) {
  const list = await accounts.listAccounts();
  const live = (list || []).filter(a => a && a.accessToken && !a._del);
  if (!live.length) return { ok: false, error: '没有可用账号，请先扫码登录或贴 refresh_token' };
  let acc = live[0];
  if (body.account) {
    const hit = live.find(a => String(a.UserID) === String(body.account));
    if (hit) acc = hit;
  }
  const payload = {
    model: body.model || 'raccoon-8c4485',
    messages: Array.isArray(body.messages) && body.messages.length ? body.messages : [{ role: 'user', content: body.prompt || '你好' }],
    stream: false,
  };
  if (Array.isArray(body.tools) && body.tools.length) { payload.tools = body.tools; if (body.tool_choice) payload.tool_choice = body.tool_choice; }
  const t0 = Date.now();
  try {
    const up = await net.request({
      base: openai.LLM_BASE, path: '/chat/completions', method: 'POST',
      headers: { Authorization: 'Bearer ' + acc.accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), timeoutMs: 90000,
    });
    const ms = Date.now() - t0;
    const data = up && (up.data || up.rawBody);
    return { ok: up.status >= 200 && up.status < 300, status: up.status, ms, account: acc.UserID, model: payload.model, raw: data };
  } catch (e) {
    return { ok: false, error: e.message, ms: Date.now() - t0, account: acc.UserID };
  }
}

// 定时触发：签到 + 到期 token 预刷新，幂等
async function tick(ctx) {
  const secret = process.env.RACCOON_CRON_SECRET;
  const q = (ctx && ctx.query) || {};
  if (secret) {
    const qk = q.key || q.token || '';
    if (qk !== secret) return util.json(ctx.res, 401, { success: false, error: '未授权' });
  }

  const started = Date.now();
  const mode = String(q.mode || 'all').toLowerCase();              // all | renew | checkin
  const concurrency = Math.max(1, Math.min(Number(q.concurrency) || 3, 6));
  const batchSize = Math.max(1, Math.min(Number(q.batch) || 30, 50));
  const budgetSec = Math.max(5, Math.min(Number(q.budget) || 42, 52)); // 给 Vercel 60s 留余量
  const offset = Math.max(0, Number(q.offset) || 0);
  const deadline = started + budgetSec * 1000;

  logs.info('cron tick 开始 mode=' + mode + ' 并发=' + concurrency + ' batch=' + batchSize + ' offset=' + offset);

  let list = [];
  try { list = await accounts.listAccounts(); } catch (e) {
    logs.error('cron tick 读账号失败: ' + e.message);
    return util.json(ctx.res, 500, { success: false, error: '读取账号失败: ' + e.message });
  }

  const live = (list || []).filter(a => a && !a._del);
  const slice = live.slice(offset, offset + batchSize);

  const one = async (acc) => {
    const uid = acc.UserID || acc.uid;
    // 1) token 保障（提前刷新）
    let et = { ok: true, refreshed: false, message: '仅签到，跳过续期' };
    if (mode !== 'checkin') {
      et = await cron.ensureToken(acc).catch(e => ({ ok: false, message: '刷新异常: ' + e.message }));
    }
    // 2) 签到
    let r = { ok: true, skipped: true, message: '仅续期，未签到' };
    if (mode !== 'renew') {
      r = await cron.checkinOne(acc).catch(e => ({ ok: false, message: '异常: ' + e.message }));
    }
    const row = {
      uid, name: acc.name,
      token: et && et.message,
      tokenRefreshed: !!(et && et.refreshed),
      ok: !!(r && r.ok),
      skipped: !!(r && r.skipped),
      message: (r && r.message) || '',
    };
    logs.push(row.ok ? 'info' : 'warn', 'tick ' + (acc.name || uid) + ': ' + row.token + ' | ' + row.message);
    return row;
  };

  const results = new Array(slice.length);
  let cursor = 0;
  let timedOut = false;
  const worker = async () => {
    for (;;) {
      const idx = cursor++;
      if (idx >= slice.length) return;
      if (Date.now() > deadline) { timedOut = true; return; }
      results[idx] = await one(slice[idx]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, slice.length || 1) }, worker));

  const out = [];
  for (let k = 0; k < slice.length; k++) {
    if (results[k]) out.push(results[k]);
    else {
      const acc = slice[k];
      out.push({ uid: acc.UserID || acc.uid, name: acc.name, ok: false, deferred: true, message: '本轮时间不足，下轮继续' });
    }
  }

  const done = out.filter(r => !r.deferred).length;
  const ok = out.filter(r => r.ok).length;
  const refreshed = out.filter(r => r.tokenRefreshed).length;
  const nextOffset = (offset + done) >= live.length ? 0 : offset + done;

  const summary = {
    success: true, mode, at: new Date().toISOString(), ms: Date.now() - started,
    total: live.length, batch: slice.length, done, ok, failed: done - ok, refreshed,
    deferred: out.length - done, timedOut, offset, nextOffset,
    results: out,
  };
  logs.info('cron tick 结束 ok=' + ok + '/' + done + ' 总 ' + live.length +
    (refreshed ? ' 续期 ' + refreshed : '') + (timedOut ? '（时间不足，下轮继续）' : ''));
  return util.json(ctx.res, 200, summary);
}

async function api(ctx) {
  const p = ctx.path || '';
  const m = (ctx.method || 'GET').toUpperCase();
  if (!authed(ctx)) return util.json(ctx.res, 401, { error: 'unauthorized' });

  // 设置
  if (p.endsWith('/settings') && m === 'GET') {
    const items = SETTING_KEYS.map(k => ({
      key: k, secret: SECRET_KEYS.has(k),
      value: SECRET_KEYS.has(k) ? mask(process.env[k]) : (process.env[k] || ''),
      set: process.env[k] !== undefined && process.env[k] !== '',
    }));
    return util.json(ctx.res, 200, { success: true, canWrite: envstore.canWrite(), items });
  }
  if (p.endsWith('/settings') && m === 'POST') {
    let body = {};
    if (ctx.query && ctx.query.k) { body = { key: ctx.query.k, value: ctx.query.v }; }
    else { try { body = JSON.parse(await util.readBody(ctx.req, 64 * 1024) || '{}'); } catch (_) {} }
    const key = String(body.key || '').trim();
    if (!SETTING_KEYS.includes(key)) return util.json(ctx.res, 400, { success: false, error: '不支持的变量名' });
    const r = await envstore.set(key, String(body.value == null ? '' : body.value));
    logs.info('设置更新 ' + key + ' -> ' + (r.ok ? 'ok' : 'fail'));
    return util.json(ctx.res, 200, { success: !!r.ok, synced: !!r.ok && !r.local, local: !!r.local, status: r.status || 0 });
  }

  // Key 管理
  if (p.endsWith('/keys') && m === 'GET') return util.json(ctx.res, 200, { success: true, items: await keys.listPublic(), backend: keys.backend() });
  if (p.endsWith('/keys') && m === 'POST') {
    let body = {};
    if (ctx.query && ctx.query.name) { body = { name: ctx.query.name }; }
    else { try { body = JSON.parse(await util.readBody(ctx.req, 16 * 1024) || '{}'); } catch (_) {} }
    const r = await keys.create(body.name);
    logs.info('新建 Key ' + (r.item && r.item.name));
    return util.json(ctx.res, 200, r);
  }
  if (p.endsWith('/keys') && m === 'DELETE') {
    const id = (ctx.query && ctx.query.id) || '';
    const r = await keys.remove(id);
    logs.info('删除 Key ' + id + ' -> ' + (r.ok ? 'ok' : r.error));
    return util.json(ctx.res, r.ok ? 200 : 400, r);
  }

  // 模型目录
  // --- 诊断：逐个账号直打上游 model_catalog，回显真实 status/code/body 片段 ---
  if (p.endsWith('/models-debug') && m === 'GET') {
    const out = { llmBase: openai.LLM_BASE, accounts: [] };
    try {
      const list = await accounts.listAccounts();
      for (const a of (list || [])) {
        if (!a || a._del) continue;
        const item = { uid: a.UserID, name: a.name, tokenLen: String(a.accessToken || '').length };
        if (!a.accessToken) { item.skip = 'no token'; out.accounts.push(item); continue; }
        try {
          const r = await net.request({
            base: openai.LLM_BASE, path: '/model_catalog', method: 'GET',
            headers: { 'Authorization': 'Bearer ' + a.accessToken, 'Accept': 'application/json' },
            timeoutMs: 15000,
          });
          item.status = r && r.status;
          let body = r && (r.rawBody || (r.data ? JSON.stringify(r.data) : ''));
          body = String(body || '');
          item.bodyHead = body.slice(0, 400);
          // 尝试数一下 categories[].models[]
          try {
            const j = JSON.parse(body);
            const d = j && (j.data !== undefined ? j.data : j);
            const cats = d && d.categories;
            if (Array.isArray(cats)) {
              item.categoryCount = cats.length;
              item.modelCount = cats.reduce((n, c) => n + ((c && Array.isArray(c.models)) ? c.models.length : 0), 0);
            } else if (Array.isArray(d)) { item.modelCount = d.length; }
          } catch (_) {}
        } catch (e) {
          item.err = String((e && e.message) || e).slice(0, 200);
        }
        out.accounts.push(item);
      }
    } catch (e) { out.fatal = String(e.message || e); }
    return util.json(ctx.res, 200, { success: true, debug: out });
  }

  // 诊断：用指定账号的 refreshToken 真实跑一次 refresh，验证 return 结构与 accessToken 是否可解析
  if (p.endsWith('/diag-refresh')) {
    const accounts = require('./accounts');
    const auth = require('./auth');
    const uidq = ctx.query && ctx.query.uid;
    if (!uidq) return util.json(ctx.res, 400, { error: 'missing uid' });
    const acc = await accounts.getAccount(uidq);
    if (!acc) return util.json(ctx.res, 404, { error: 'no such account' });
    if (!acc.refreshToken) return util.json(ctx.res, 400, { error: 'account has no refreshToken' });
    const r = await auth.refresh(acc.refreshToken);
    return util.json(ctx.res, 200, {
      ok: !!r.ok,
      code: r.code || null,
      message: r.message || null,
      hasAccessToken: !!(r.data && r.data.accessToken),
      accessTokenLen: String((r.data && r.data.accessToken) || '').length,
      accessTokenHead: String((r.data && r.data.accessToken) || '').slice(0, 12),
      hasRefreshToken: !!(r.data && r.data.refreshToken),
      refreshTokenLen: String((r.data && r.data.refreshToken) || '').length,
      expiresIn: (r.data && r.data.expiresIn) || null,
      userKeys: r.data && r.data.user ? Object.keys(r.data.user) : [],
      userName: (r.data && r.data.user && r.data.user.name) || null,
      rawDataKeys: r.data && r.data.raw ? Object.keys(r.data.raw) : [],
    });
  }

  // 调用统计：/api/x/stats?days=7
  // KV 命令计数（观测本实例生命周期内的 KV 消耗；Upstash 免费额度按命令数计）
  if (p.endsWith('/kv-metrics')) {
    const kv = require('./kv');
    const m = kv.metrics ? kv.metrics() : null;
    if (ctx.query && ctx.query.reset === '1' && kv.resetMetrics) kv.resetMetrics();
    return util.json(ctx.res, 200, {
      success: true,
      available: kv.available ? kv.available() : false,
      metrics: m,
      note: '本实例生命周期内的累计值；实例重启会归零。reset=1 可清零。',
      tips: {
        accountsCacheTtlMs: Number(process.env.RACCOON_ACCOUNTS_TTL_MS || 3000),
        statsFlushEveryN: 10,
        statsFlushEveryMs: 20000,
        keysTtlMs: 30000,
      },
    });
  }
  if (p.endsWith('/stats')) {
    const stats = require('./stats');
    const dq = (ctx.query && ctx.query.days) || 7;
    const data = await stats.summary(dq);
    // 附带账号当前积分（用于「积分消耗」对照）
    let accountsPts = [];
    try {
      const accs = await accounts.listAccounts();
      for (const a of accs) {
        if (a._del || !a.accessToken) continue;
        let pts = null, httpStatus = 0, perr = null;
        try {
          const r = await checkin.balance(a.accessToken);
          httpStatus = (r && r.status) || 0;
          const pick = (o) => {
            if (!o || typeof o !== 'object') return null;
            for (const k of ['available_points', 'balance', 'points', 'total', 'total_chargeable_points']) {
              if (o[k] !== undefined && o[k] !== null) {
                const n = Number(o[k]);
                if (isFinite(n)) return n;
              }
            }
            return null;
          };
          const rd = (r && r.data) || null;
          pts = pick(rd);
          if (pts === null && rd && rd.data) pts = pick(rd.data);
          if (pts === null && rd) pts = pick(rd);   // rd 本身就是内层 data 的兜底
          if (pts === null && httpStatus >= 400) perr = 'HTTP ' + httpStatus;
        } catch (e) { perr = String((e && e.message) || e).slice(0, 120); }
        accountsPts.push({ uid: a.UserID || a.uid, name: a.name, points: pts, httpStatus, err: perr });
      }
    } catch (_) {}
    return util.json(ctx.res, 200, { success: true, ...data, accountsPoints: accountsPts });
  }

  // 清空今日统计（调试用）
  if (p.endsWith('/stats-reset') && (ctx.method || '').toUpperCase() === 'DELETE') {
    const stats = require('./stats');
    const kv = require('./kv');
    const days = Math.min(Math.max(Number((ctx.query && ctx.query.days) || 1), 1), 60);
    let cleared = 0;
    for (let i = 0; i < days; i++) {
      const d = new Date(Date.now() + 8 * 3600 * 1000 - i * 86400000).toISOString().slice(0, 10);
      try { if (await kv.del('raccoon:stats:day:' + d)) cleared++; } catch (_) {}
    }
    return util.json(ctx.res, 200, { success: true, cleared });
  }

  // 诊断：取一个真实账号 accessToken 直打上游 LLM 对话接口，定位 000 卡在哪
  if (p.endsWith('/diag-llm')) {
    const accounts = require('./accounts');
    const net2 = require('./net');
    const live = (await accounts.listAccounts()).filter(a => !a._del && a.accessToken);
    if (!live.length) return util.json(ctx.res, 400, { error: 'no account' });
    const acc = live[0];
    const t0 = Date.now();
    try {
      const r = await net2.request({
        base: openai.LLM_BASE, path: '/chat/completions', method: 'POST',
        headers: { 'Authorization': 'Bearer ' + acc.accessToken, 'Content-Type': 'application/json' },
        body: { model: 'raccoon-8c4485', messages: [{ role: 'user', content: 'hi' }], stream: false },
        timeoutMs: 55000, raw: true,
      });
      return util.json(ctx.res, 200, {
        status: r && (r.status || r.statusCode), ms: Date.now() - t0,
        bodyLen: String(r && (r.rawBody || r.data || '')).length,
        bodyHead: String(r && (r.rawBody || r.data || '')).slice(0, 400),
        uid: acc.UserID, ATlen: String(acc.accessToken).length,
      });
    } catch (e) {
      return util.json(ctx.res, 200, { error: e.message, ms: Date.now() - t0, uid: acc.UserID });
    }
  }

  // 诊断：KV 里账号的原始字段结构（token 只显示长度，不泄露明文）
  // 诊断：对比账号的权益与设置，找 web 端积分发放条件
  if (p.endsWith('/diag-entitlement')) {
    const accounts = require('./accounts');
    const checkin = require('./checkin');
    const net = require('./net');
    const uidq = ctx.query && ctx.query.uid;
    if (!uidq) return util.json(ctx.res, 400, { error: 'missing uid' });
    const acc = await accounts.getAccount(uidq);
    if (!acc || !acc.accessToken) return util.json(ctx.res, 400, { error: 'no accessToken' });
    const tk = acc.accessToken;
    const out = { uid: uidq, name: acc.name };

    // 1) entitlement_info（权益）
    try {
      const r1 = await net.request({
        base: process.env.RACCOON_MAIN_ORIGIN || 'https://xiaohuanxiong.com',
        path: '/api/web/auth/v1/entitlement_info',
        method: 'GET',
        headers: checkin.headers(tk),
        timeoutMs: 15000,
      });
      out.entitlement = { status: r1.status, body: String(r1.rawBody || '').slice(0, 1200) };
    } catch (e) { out.entitlement = { error: String(e.message || e) }; }

    // 2) setting_info（含 point_grant_popups / point_grant_toast）
    try {
      const r2 = await checkin.setting(tk);
      out.setting = { status: r2.status, body: String(r2.rawBody || '').slice(0, 1500) };
    } catch (e) { out.setting = { error: String(e.message || e) }; }

    // 3) 最近的 bills（看 daily_grant 历史）
    try {
      const r3 = await checkin.bills(tk, 10, 0);
      out.bills = { status: r3.status, body: String(r3.rawBody || '').slice(0, 2000) };
    } catch (e) { out.bills = { error: String(e.message || e) }; }

    return util.json(ctx.res, 200, out);
  }

  if (p.endsWith('/diag-accounts')) {
    const kv = require('./kv');
    const accounts = require('./accounts');
    const out = { kvAvailable: kv.available ? kv.available() : false, items: [] };
    try {
      const keys = await kv.keys('acct:*');
      out.kvKeys = keys.length;
      for (const k of keys.slice(0, 10)) {
        const raw = await kv.get(k);
        let o = null;
        try { o = JSON.parse(raw); } catch (_) {}
        if (!o) { out.items.push({ key: k, parseFail: true, rawLen: String(raw || '').length }); continue; }
        out.items.push({
          key: k,
          UserID: o.UserID || null,
          name: o.name || null,
          hasAccessToken: !!o.accessToken,
          accessTokenLen: String(o.accessToken || '').length,
          accessTokenHead: String(o.accessToken || '').slice(0, 12),
          hasRefreshToken: !!o.refreshToken,
          refreshTokenLen: String(o.refreshToken || '').length,
          expiryMs: o.expiryMs || null,
          _mtime: o._mtime || null,
          fieldNames: Object.keys(o),
        });
      }
      out.listAccountsCount = (await accounts.listAccounts()).length;
    } catch (e) {
      out.error = String((e && e.message) || e);
    }
    return util.json(ctx.res, 200, out);
  }

  if (p.endsWith('/models') && m === 'GET') {
    const data = await listModels();
    return util.json(ctx.res, 200, { success: true, data });
  }

  // 调试
  if (p.endsWith('/chat-debug') && m === 'POST') {
    let body = {};
    if (ctx.query && (ctx.query.prompt || ctx.query.model)) {
      body = { prompt: ctx.query.prompt || '你好', model: ctx.query.model || '' };
      if (ctx.query.account) body.account = ctx.query.account;
      if (ctx.query.tools) { try { body.tools = JSON.parse(ctx.query.tools); } catch (_) {} }
      if (ctx.query.tool_choice) body.tool_choice = ctx.query.tool_choice;
    } else {
      try { body = JSON.parse(await util.readBody(ctx.req, 1024 * 1024) || '{}'); } catch (e) {
        return util.json(ctx.res, 400, { ok: false, error: '请求体不是合法 JSON' });
      }
    }
    const r = await chatDebug(ctx, body);
    logs.push(r.ok ? 'info' : 'warn', '调试请求 ' + (r.model || '') + ' -> ' + (r.ok ? 'ok' : (r.error || r.status)));
    return util.json(ctx.res, 200, r);
  }

  // 日志
  if (p.endsWith('/logs') && m === 'GET') {
    const limit = Number((ctx.query && ctx.query.limit) || 200);
    // KV + 内存并集，跨部署也能看到历史日志
    const items = await logs.listAsync(limit);
    return util.json(ctx.res, 200, { success: true, items, backend: logs.backend() });
  }
  if (p.endsWith('/logs') && m === 'DELETE') {
    await logs.clear();
    return util.json(ctx.res, 200, { success: true });
  }

  return util.json(ctx.res, 404, { error: 'not found' });
}

module.exports = { api, tick, listModels, chatDebug };
