'use strict';
// 小浣熊认证协议（严格按 RaccoonProvider.java 反编译实现）
// AUTH_BASE = https://xiaohuanxiong.com/api/web/auth/v1
const net = require('./net');

const AUTH_BASE = process.env.RACCOON_AUTH_BASE || 'https://xiaohuanxiong.com/api/web/auth/v1';

// -------- JWT：URL-safe Base64 解码 payload，读 name/nickname/expiryMs --------
function b64urlDecode(s) {
  let b = s.replace(/-/g, '+').replace(/_/g, '/');
  while (b.length % 4) b += '=';
  return Buffer.from(b, 'base64').toString('utf8');
}
function decodeJwt(token) {
  if (!token) return {};
  try {
    // 去掉 Bearer 前缀
    const t = String(token).replace(/^Bearer\s+/i, '');
    const parts = t.split('.');
    if (parts.length < 2) return {};
    const payload = JSON.parse(b64urlDecode(parts[1]));
    // 字段尽力而为
    const out = {
      name: payload.name || payload.nickname || payload.sub || payload.userName || '',
      nickname: payload.nickname || payload.name || '',
      uid: payload.uid || payload.userId || payload.sub || payload.user_id || '',
      org: payload.orgName || payload.org || '',
      expiryMs: null,
      exp: payload.exp || null,
    };
    if (payload.exp) out.expiryMs = payload.exp * 1000;
    return out;
  } catch (e) {
    return {};
  }
}
function stripBearer(token) {
  return String(token || '').replace(/^Bearer\s+/i, '');
}
function isExpired(token, nowMs) {
  return decodeJwt(token).expiryMs ? decodeJwt(token).expiryMs <= (nowMs || Date.now()) + 60 * 1000 : false;
}

// -------- 换票：POST {auth}/login_with_authorization_code  body {"authorization_code":code} --------
async function exchangeCode(code) {
  const r = await net.request({
    base: AUTH_BASE,
    path: '/login_with_authorization_code',
    method: 'POST',
    body: { authorization_code: code },
    timeoutMs: 30000,
  });
  return normalizeAuth(r);
}

// -------- 刷新：POST {auth}/refresh  body {"refresh_token":...} --------
async function refresh(token) {
  const r = await net.request({
    base: AUTH_BASE,
    path: '/refresh',
    method: 'POST',
    body: { refresh_token: token },
    timeoutMs: 30000,
  });
  return normalizeAuth(r);
}

// 统一把换票/刷新响应转成 {ok, code, message, data:{accessToken, refreshToken, ...}, raw}
function normalizeAuth(r) {
  if (!r.data) {
    return { ok: false, code: 'bad_response', message: '空响应（HTTP ' + r.status + '）' };
  }
  const code = r.data.code;
  if (r.status >= 200 && r.status < 300 && code === 0) {
    const d = r.data.data || {};
    const payload = decodeJwt(d.accessToken || '');
    return {
      ok: true,
      code,
      message: r.data.message || '',
      data: {
        accessToken: d.accessToken || '',
        refreshToken: d.refreshToken || '',
        expiresIn: d.expiresIn || d.expires_in || null,
        user: payload,
        raw: d,
      },
      raw: r.data,
    };
  }
  // 业务错误：code 非 0（如 200035 code过期）
  return {
    ok: false,
    code: String(code),
    message: r.data.message || r.data.msg || ('HTTP ' + r.status),
    raw: r.data,
  };
}

// 通用鉴权头（需要 accessToken）
function authHeaders(token, extra) {
  return Object.assign({
    'Authorization': 'Bearer ' + stripBearer(token),
    'Accept': 'application/json',
  }, extra || {});
}

module.exports = {
  AUTH_BASE, exchangeCode, refresh,
  decodeJwt, stripBearer, isExpired, authHeaders,
};

