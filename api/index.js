'use strict';
// ============================================================
// raccoon2api-vercel 入口：纯 Vercel serverless（零依赖）
// 单入口分派所有路由。模块按需加载（require 缓存）。
// handler: (req, res) => Promise<void>
// ============================================================
const util = require('../lib/util');

const routes = [];
function add(method, pattern, handler) {
  routes.push({ method: method || '*', pattern, handler });
}

// 解析 url：分离 path + query
function parseUrl(raw) {
  const qi = raw.indexOf('?');
  const path = qi >= 0 ? raw.slice(0, qi) : raw;
  const qs  = qi >= 0 ? raw.slice(qi + 1) : '';
  return { path, query: util.parseQuery(qs) };
}

// 构造 ctx（Vercel / dev-server 共用）
async function makeCtx(req, res) {
  const { path, query } = parseUrl(req.url || '/');
  let body = null, json = null;
  try { body = await util.readBody(req); } catch (_) { body = null; }
  if (body) { try { json = util.parseJson(body); } catch (_) { json = body; } }
  return {
    req, res, url: req.url, path, query, params: {},
    method: (req.method || 'GET').toUpperCase(),
    headers: req.headers || {},
    rawBody: body, body: json,
  };
}

// 统一分发器
async function dispatch(ctx) {
  const { path, method } = ctx;
  for (const r of routes) {
    if (r.method !== '*' && r.method !== method) continue;
    let m = null;
    if (typeof r.pattern === 'string') {
      if (path !== r.pattern) continue;
    } else if (r.pattern instanceof RegExp) {
      m = path.match(r.pattern);
      if (!m) continue;
    } else continue;
    ctx.params = (m && m.groups) ? m.groups : (m ? { 0: m[0], index: m.index } : {});
    await r.handler(ctx);
    return;
  }
  util.json(ctx.res, 404, { error: 'not_found', path });
}

module.exports = async function handler(req, res) {
  try {
    const ctx = await makeCtx(req, res);
    await dispatch(ctx);
  } catch (e) {
    if (!res.headersSent) {
      util.json(res, 500, { error: 'internal', message: String(e && e.message) });
    } else {
      try { res.end(); } catch (_) {}
    }
  }
};

// ---------- 路由注册 ----------
// 健康检查
add('GET', '/health', async (ctx) => {
  util.json(ctx.res, 200, { ok: true, service: 'raccoon2api-vercel', time: Date.now() });
});

// 登录页
add('GET', '/login', async (ctx) => (await require('../lib/qrlogin')).page(ctx));
add('GET', '/callback', async (ctx) => (await require('../lib/login')).callback(ctx));
add('POST', '//submit-code', async (ctx) => (await require('../lib/login')).handleSubmit(ctx));
add('GET', '/api/qrcode', async (ctx) => (await require('../lib/qrlogin')).qrcodeApi(ctx));
add('GET', '/api/qrcode-poll', async (ctx) => (await require('../lib/qrlogin')).pollApi(ctx));
add('GET', '/submit-code', async (ctx) => (await require('../lib/login')).handleSubmit(ctx));

// 每日自动签到
add('*', /^\/api\/cron\/maintain$/, async (ctx) => (await require('../lib/cron')).maintain(ctx));

// OpenAI 兼容网关
add('*', /^\/v1\/(chat\/completions|models|completions)$/, async (ctx) => (await require('../lib/openai')).route(ctx));

// 迁移：把 env 里的账号搬进 KV（一次性，幂等）
add('POST', '/api/admin/migrate-kv', async (ctx) => {
  const accounts = require('../lib/accounts');
  try {
    const r = await accounts.syncAllEnv();
    return util.json(ctx.res, 200, { ok: true, ...r });
  } catch (e) {
    return util.json(ctx.res, 500, { ok: false, error: String(e.message || e).slice(0, 300) });
  }
});

// 诊断：账号存储后端（KV / env / file）+ KV 连通性
add('GET', '/api/x/diag', async (ctx) => {
  const accounts = require('../lib/accounts');
  const kv = require('../lib/kv');
  const out = { backend: accounts.backend ? accounts.backend() : 'unknown', kv: kv.info ? kv.info() : null };
  try {
    if (kv.available && kv.available()) {
      out.kvWrite = await kv.set('__diag_probe', String(Date.now()));
      out.kvRead = await kv.get('__diag_probe');
      out.kvOk = !!out.kvRead;
      await kv.del('__diag_probe');
    }
  } catch (e) { out.kvError = String(e.message || e).slice(0, 200); }
  return util.json(ctx.res, 200, out);
});

// 管理面板 + 管理 API
add('*', /^\/admin(\/.*)?$/, async (ctx) => (await require('../lib/admin')).route(ctx));
add('*', /^\/api\/admin(\/.*)?$/, async (ctx) => (await require('../lib/admin')).api(ctx));
add('*', /^\/api\/cron\/tick$/, async (ctx) => (await require('../lib/extras')).tick(ctx));
add('*', /^\/api\/x\//, async (ctx) => (await require('../lib/extras')).api(ctx));

// 根路径 → 后台面板（登录 + 账号管理 + 数据查看都在里面，不摆跳转引导页）
add('GET', '/', async (ctx) => {
  const admin = await require('../lib/admin');
  return admin.route(ctx);
});
