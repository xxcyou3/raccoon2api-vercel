'use strict';
// /login 扫码登录页：网页版扫码（打开授权页）+ 手动贴 code 备选
// 换票后写入环境变量（每账号一条 RACCOON_ACCT_<uid>），支持多账号/重扫。
const auth = require('./auth');
const accounts = require('./accounts');
const util = require('./util');

const ORIGIN = 'https://xiaohuanxiong.com';
const AUTHORIZE_PATH = '/code/authorize';

// 生成一次性 state（防跨站伪造），存在内存即可（登录是即时交互）
let _state = null;

function buildAuthorizeUrl() {
  _state = util.randomToken(24);
  const appname = encodeURIComponent('办公小浣熊客户端');
  return `${ORIGIN}${AUTHORIZE_PATH}?login_source=desktop&appname=${appname}&state=${_state}`;
}

// 从用户粘贴的内容解析 (code, state)：接受完整回调 URL 或纯 code
function parseCallback(raw) {
  if (!raw) return null;
  raw = String(raw).trim();
  // 完整回调：office-raccoon://auth/callback?code=xxx&state=yyy 或 ?code=xxx
  const m = raw.match(/office-raccoon:\/\/auth\/callback[^a-zA-Z0-9]*(.*)/);
  const part = m ? m[1] : raw;
  const qIdx = part.indexOf('?');
  const q = qIdx >= 0 ? part.slice(qIdx + 1) : part;
  const params = util.parseQuery(q);
  if (params.code) return { code: params.code, state: params.state || null };
  // 纯 code 形式（一段不含 & 的长字符串）：当作 code
  if (/^[A-Za-z0-9_.-]{8,}$/.test(raw)) return { code: raw, state: null };
  return null;
}

// 渲染登录页
function renderPage(ctx, { error } = {}) {
  const authUrl = buildAuthorizeUrl();
  const t = new Date().toISOString().replace(/[:.]/g, '-');
  const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>小浣熊网关 · 登录</title>
<style>
:root{--gold:#d4af37;--bg:#101018;--card:#171722;--line:#2a2a3a;--text:#e8e8f0;--muted:#8b8ba0}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:32px;max-width:420px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.5)}
h1{font-size:20px;margin-bottom:6px}
.sub{color:var(--muted);font-size:13px;margin-bottom:24px}
.btn{display:block;width:100%;padding:14px;border:none;border-radius:10px;background:linear-gradient(135deg,#d4af37,#b8860b);color:#1a1507;font-size:15px;font-weight:700;cursor:pointer;margin-bottom:14px}
.btn:hover{filter:brightness(1.1)}
.or{display:flex;align-items:center;color:var(--muted);font-size:12px;margin:8px 0 18px}
.or::before,.or::after{content:"";flex:1;height:1px;background:var(--line);margin:0 10px}
label{display:block;font-size:13px;color:var(--muted);margin-bottom:6px}
input{width:100%;padding:12px;border:1px solid var(--line);border-radius:10px;background:#0f0f18;color:var(--text);font-size:14px;margin-bottom:16px}
input:focus{outline:none;border-color:var(--gold)}
.submit{width:100%;padding:13px;border:none;border-radius:10px;background:#2a2a3a;color:var(--text);font-size:15px;cursor:pointer}
.submit:hover{background:#3a3a4e}
.err{background:#3a1414;border:1px solid #7a2a2a;color:#ff9d9d;padding:12px;border-radius:10px;font-size:13px;margin-bottom:16px;white-space:pre-wrap}
.tip{color:var(--muted);font-size:12px;margin-top:16px;line-height:1.7}
</style></head><body>
<div class="card">
<h1>小浣熊办公 · 登录</h1>
<div class="sub">完成登录后自动换票并写入环境变量，可随时重扫</div>
${error?`<div class="err">${error}</div>`:''}
<a class="btn" href="${authUrl}" target="_blank" rel="noopener">① 打开授权页扫码</a>
<div class="or">或</div>
<label>② 扫码后把回调地址 / 授权码粘贴到下面</label>
<form method="POST" action="/submit-code">
<input type="text" name="code" placeholder="office-raccoon://auth/callback?code=... 或直接贴 code" autocomplete="off">
<button class="submit" type="submit">换票并添加账号</button>
</form>
<div class="tip">在①的新标签页里微信扫码授权，授权成功后地址栏会跳到一个 office-raccoon://... 的地址（桌面端才显示）；若看不到，可把该地址或其中的 code 整段复制过来。<br>失败？回来说明弹窗里那种方式。${t}</div>
</div></body></html>`;
  return util.html(ctx.res, 200, html);
}

// 处理手动提交的 code：换票 -> 存账号
async function handleSubmit(ctx) {
  try {
    const body = await util.readBody(ctx.req, 1 << 20);
    const params = new URLSearchParams(body);
    const raw = params.get('code') || '';
    const parsed = parseCallback(raw);
    if (!parsed || !parsed.code) {
      return renderPage(ctx, { error: '未识别到授权码，请粘贴完整的回调地址或 code。' });
    }
    // 换票
    const ex = await auth.exchangeCode(parsed.code);
    if (!ex || !ex.accessToken) {
      return renderPage(ctx, { error: '换票失败：' + (ex && ex.error ? ex.error : '响应缺少 accessToken，授权码可能已过期。') });
    }
    // 存账号
    const account = {
      UserID: ex.userId || ex.officeIdentity || 'u-' + util.randomToken(8),
      name: ex.name || ex.nickname || '未命名',
      accessToken: ex.accessToken,
      refreshToken: ex.refreshToken,
      expiryMs: ex.expiryMs || 0,
      updatedAt: Date.now(),
    };
    await accounts.saveAccount(account);
    return util.json(ctx.res, 200, { success: true, account: { UserID: account.UserID, name: account.name } });
  } catch (e) {
    return renderPage(ctx, { error: '登录失败：' + e.message });
  }
}

// GET /login
async function page(ctx) {
  return renderPage(ctx);
}


// GET /callback  —— 扫码授权后浏览器回跳到本页（如 ?code=xxx&state=xxx）
// 这里直接用 query 里的 code 换票存账号。若打开的是 office-raccoon:// 深链，
// 浏览器/微信会拦走拿不到；因此本页同时接受手动粘贴回调地址（走 /submit-code）。
async function callback(ctx) {
  try {
    const q = ctx.query || {};
    let code = q.code;
    const state = q.state || null;
    if (!code) {
      // 尝试从完整 query 串解析（可能整段是 office-raccoon://...?code=xxx）
      const parsed = parseCallback(ctx.url || '');
      if (parsed && parsed.code) code = parsed.code;
    }
    if (!code) return renderPage(ctx, { error: '回调里没有授权码（code）。请回到登录页，扫码后把地址栏里的 office-raccoon://... 整段复制粘贴。' });
    const ex = await auth.exchangeCode(code);
    if (!ex || !ex.accessToken) {
      return renderPage(ctx, { error: '换票失败：' + (ex && ex.error ? ex.error : '响应缺少 accessToken，授权码可能已过期。') });
    }
    const account = {
      UserID: ex.userId || ex.officeIdentity || 'u-' + util.randomToken(8),
      name: ex.name || ex.nickname || '未命名',
      accessToken: ex.accessToken,
      refreshToken: ex.refreshToken,
      expiryMs: ex.expiryMs || 0,
      updatedAt: Date.now(),
    };
    await accounts.saveAccount(account);
    return renderPage(ctx, { error: '✔ 登录成功，账号已添加（' + (account.UserID || account.name) + '）。可关闭本页。' });
  } catch (e) {
    return renderPage(ctx, { error: '登录失败：' + e.message });
  }
}

module.exports = { page, callback, handleSubmit, buildAuthorizeUrl, parseCallback };
