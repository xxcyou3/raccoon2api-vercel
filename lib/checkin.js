'use strict';
// 小浣熊签到/积分协议（严格按 RaccoonProvider.checkin 反编译实现）
// 签到：POST {main}/api/web/desktop/v1/login/points/grant
// 余额：GET {main}/api/web/points/v1/balance
// 账单：GET {main}/api/web/points/v1/bills?paging.limit=20&paging.offset=0
// 设置：GET {main}/api/web/office/v3/setting_info
const net = require('./net');

const MAIN_ORIGIN = process.env.RACCOON_MAIN_ORIGIN || 'https://xiaohuanxiong.com';
const CLIENT_PLATFORM = process.env.RACCOON_PLATFORM || 'desktop-windows';
const CLIENT_VERSION = process.env.RACCOON_VERSION || 'v1.0.0';

// 签到/积分请求的统一头（按反编译：带 X-Client-Platform / X-Client-Version / X-Raccoon-Language）
function headers(token) {
  return {
    'Authorization': 'Bearer ' + String(token || '').replace(/^Bearer\s+/i, ''),
    'Accept': 'application/json',
    'X-Client-Platform': CLIENT_PLATFORM,
    'X-Client-Version': CLIENT_VERSION,
    'X-Raccoon-Language': 'zh',
  };
}

// ---- IAM 业务确认：POST /api/web/auth/v1/iam/confirm ----
// 网页扫码拿到的 token 首次调业务接口会返回 400 + code 200901 iam_confirm_required，
// 官网前端遇到这个错误会先 POST iam/confirm（Bearer token + 空 context）再重试原请求。
const AUTH_ORIGIN = process.env.RACCOON_AUTH_ORIGIN || 'https://xiaohuanxiong.com';

function bearerOf(token) {
  return 'Bearer ' + String(token || '').replace(/^Bearer\s+/i, '');
}

function envelopeCode(r) {
  const d = r && (r.data || r.json);
  if (d && d.code !== undefined) return d.code;
  const raw = r && (r.rawBody || r.raw);
  if (typeof raw === 'string') {
    try { return JSON.parse(raw).code; } catch (_) {}
  }
  return undefined;
}

async function iamConfirm(token) {
  return net.request({
    base: AUTH_ORIGIN,
    path: '/api/web/auth/v1/iam/confirm',
    method: 'POST',
    headers: {
      'Authorization': bearerOf(token),
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'X-Client-Platform': CLIENT_PLATFORM,
      'X-Client-Version': CLIENT_VERSION,
      'X-Raccoon-Language': 'zh',
    },
    body: {},
    timeoutMs: 15000,
  });
}

// 业务请求包装：命中 200901 时先做 IAM 确认，再重试一次
async function requestWithIam(opts, token) {
  let r = await net.request(opts);
  if (r && r.status === 400 && envelopeCode(r) === 200901) {
    try { await iamConfirm(token); } catch (_) {}
    r = await net.request(opts);
  }
  return r;
}

// ---- 签到领积分：POST /api/web/desktop/v1/login/points/grant ----
async function grant(token) {
  const r = await requestWithIam({
    base: MAIN_ORIGIN,
    path: '/api/web/desktop/v1/login/points/grant',
    method: 'POST',
    headers: headers(token),
    body: {},            // 签到可能不需要 body（反编译里 grant 无 body 或空体）
    timeoutMs: 20000,
  }, token);
  return r;
}

// ---- 余额：GET /api/web/points/v1/balance ----
async function balance(token) {
  const r = await requestWithIam({
    base: MAIN_ORIGIN,
    path: '/api/web/points/v1/balance',
    method: 'GET',
    headers: headers(token),
    timeoutMs: 20000,
  }, token);
  return r;
}

// ---- 账单：GET /api/web/points/v1/bills?paging.limit=20&paging.offset=0 ----
async function bills(token, limit, offset) {
  const r = await requestWithIam({
    base: MAIN_ORIGIN,
    path: '/api/web/points/v1/bills?paging.limit=' + (limit || 20) + '&paging.offset=' + (offset || 0),
    method: 'GET',
    headers: headers(token),
    timeoutMs: 25000,
  }, token);
  return r;
}

// ---- 设置：GET /api/web/office/v3/setting_info ----
async function setting(token) {
  const r = await requestWithIam({
    base: MAIN_ORIGIN,
    path: '/api/web/office/v3/setting_info',
    method: 'GET',
    headers: headers(token),
    timeoutMs: 15000,
  }, token);
  return r;
}

// ---- 今日是否已签到/入账：拉账单核对有没有今天的 positive 入账 ----
// 返回 {checked:bool, found:bool, point:number, reason:string}
async function checkTodayGranted(token) {
  const today = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const todayPrefix = today.getFullYear() + '-' + pad(today.getMonth() + 1) + '-' + pad(today.getDate());
  try {
    const r = await bills(token, 20, 0);
    const data = r.data && r.data.data;
    // 上游真实结构是 data.items（不是 records/list），三个都兼容
    const list = (data && (data.items || data.records || data.list || (Array.isArray(data) ? data : []))) || [];
    // 按 APK checkin 500-517 行：累加今日全部 positive 入账（不是取第一条）
    let sum = 0;
    const grants = [];
    for (const it of list) {
      const created = it.created_at || it.createdAt || it.time || '';
      if (!String(created).startsWith(todayPrefix)) continue;
      const points = Number(it.points || it.amount || it.change || 0);
      if (points > 0) {
        sum += points;
        grants.push({
          event: it.event_name || it.eventName || '积分发放',
          points: points,
          bizType: it.biz_type || it.bizType || '',
          createdAt: created,
        });
      }
    }
    if (sum > 0) {
      return { checked: true, found: true, point: sum, grants: grants, reason: '今日已入账 ' + sum + ' 分' };
    }
    return { checked: true, found: false, point: 0, grants: [], reason: '今日账单无 positive 入账' };
  } catch (e) {
    return { checked: false, found: false, point: 0, grants: [], reason: '账单查询失败: ' + e.message };
  }
}

module.exports = { grant, balance, bills, setting, checkTodayGranted, headers, iamConfirm, requestWithIam, MAIN_ORIGIN, AUTH_ORIGIN };

