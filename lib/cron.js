
'use strict';
// /api/cron/maintain 每日自动签到（Vercel Cron 每天触发）
// 幂等：当天已签到跳过；token 过期先刷新再签；失败当日上限防风控；迟到补签天然覆盖。
const auth   = require('./auth');
const checkin= require('./checkin');
const accounts= require('./accounts');
const util   = require('./util');

const MAX_DAILY_FAIL = 4;              // 单账号当日失败上限，防触发风控
const IN_MEMORY_STATE = {};            // 当日失败计数（Vercel 每实例独立，够当"当日防抖"）

function dayKey() { return new Date().toISOString().slice(0,10); }

// 确保账号有可用 accessToken；过期则用 refreshToken 刷新并落盘新票
const REFRESH_AHEAD_MS = 30 * 60 * 1000;   // 提前 30 分钟刷新（外部一小时触发一次也够用）

// 从 JWT 里取过期时间（毫秒）；拿不到返回 0
function tokenExpMs(token) {
  try {
    const part = String(token || '').split('.')[1];
    if (!part) return 0;
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const obj = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    return obj && obj.exp ? Number(obj.exp) * 1000 : 0;
  } catch (_) { return 0; }
}

// 确保账号有可用 accessToken：快过期（默认提前 30 分钟）就主动刷新并落盘新票
async function ensureToken(acc, opts) {
  const ahead = (opts && typeof opts.refreshAheadMs === 'number') ? opts.refreshAheadMs : REFRESH_AHEAD_MS;
  const exp = tokenExpMs(acc.accessToken) || Number(acc.expiryMs || 0);
  const remain = exp ? (exp - Date.now()) : 0;

  if (acc.accessToken && exp && remain >= ahead) {
    return { ok: true, refreshed: false, message: 'token 有效（剩余 ' + Math.round(remain / 60000) + ' 分钟）' };
  }
  if (acc.accessToken && !exp) {
    return { ok: true, refreshed: false, message: 'token 有效（无过期信息）' };
  }
  if (!acc.refreshToken) {
    return acc.accessToken
      ? { ok: true, refreshed: false, message: 'token 即将过期，但无 refreshToken' }
      : { ok: false, message: '无 refreshToken，无法刷新' };
  }

  const r = await auth.refresh(acc.refreshToken);
  if (r && r.ok && r.data && r.data.accessToken) {
    acc.accessToken = r.data.accessToken;
    if (r.data.refreshToken) acc.refreshToken = r.data.refreshToken;
    if (r.data.expiresIn) acc.expiryMs = Date.now() + Number(r.data.expiresIn) * 1000;
    else acc.expiryMs = tokenExpMs(acc.accessToken) || acc.expiryMs;
    acc.updatedAt = Date.now();
    await accounts.saveAccount(acc);   // 落盘新票（写前远端合并，防丢号）
    return { ok: true, refreshed: true, message: 'token 已提前刷新' };
  }

  // 刷新失败：旧 token 还没过期就继续用
  if (acc.accessToken && exp && remain > 0) {
    return { ok: true, refreshed: false, message: '刷新失败，沿用旧 token（剩余 ' + Math.round(remain / 60000) + ' 分钟）' };
  }
  return { ok: false, message: '刷新失败: ' + ((r && r.message) || '未知错误') };
}

// 单账号签到
async function checkinOne(acc) {
  const dk = dayKey();
  const uid = String(acc.UserID || acc.uid || '');
  if (!uid) return { uid, ok:false, message:'缺账号标识' };

  // token 保障
  const t = await ensureToken(acc);
  if (!t.ok) return { uid, ok:false, message:'token 不可用: ' + t.message };
  const token = acc.accessToken;

  // 幂等：今日是否已入账
  const prior = await checkin.checkTodayGranted(token);
  if (prior.checked && prior.found) {
    return { uid, name: acc.name, ok:true, skipped:true, message:'今日已签到（' + prior.reason + '）' };
  }

  // 当日失败计数
  const key = uid + ':' + dk;
  const fail = IN_MEMORY_STATE[key] || 0;
  if (fail >= MAX_DAILY_FAIL) {
    return { uid, name: acc.name, ok:false, message:'已达当日失败上限(' + MAX_DAILY_FAIL + ')，跳过防风控' };
  }

  // 调用签到接口
  try {
    // 注意：checkin.grant() 返回的是 net.request 的原始结构 {status, headers, data, rawBody}，
    // 没有 ok 字段（曾经误用 g.ok 判定，导致 HTTP 200 也被判成"签到接口失败"）。
    const g = await checkin.grant(token);
    const httpOk = g && (g.status === 200 || g.status === 201);
    const envCode = g && g.data && g.data.code;
    const envOk = envCode === 0 || envCode === undefined;
    const grantOk = !!httpOk && !!envOk;

    // grant 只做"敲门"。web 会话的 grant 恒返回 granted:false，
    // 但当天首次访问业务接口时服务端会自动发放 daily_grant(+300)，
    // 所以签到后主动查一次余额，触发这次发放。
    let balanceAfter = null;
    try {
      const bal = await checkin.balance(token);
      const bd = bal && bal.data && (bal.data.data || bal.data);
      if (bd) balanceAfter = bd.available_points ?? bd.balance ?? bd.points ?? null;
    } catch (_) {}

    // 最终以「今日账单是否入账」为准（与面板、APK 第 543 行逻辑一致）
    const after = await checkin.checkTodayGranted(token);
    let okSign = false;
    let msg = '';
    if (after.checked && after.found) {
      okSign = true;
      msg = (after.dailyPoint > 0)
        ? ('今日已签到，每日积分 +' + after.dailyPoint)
        : ('今日已签到，入账 ' + after.point + ' 分');
    } else if (!grantOk) {
      msg = '签到接口异常: HTTP ' + ((g && g.status) || '?') +
            (envCode !== undefined ? ' / code ' + envCode : '');
    } else if (after.checked) {
      msg = '签到已提交但今日账单未入账（可能已达领取条件上限）';
    } else {
      msg = '账单核对失败: ' + (after.reason || '未知');
    }
    if (balanceAfter !== null) msg += '，余额 ' + balanceAfter;
    if (!okSign) IN_MEMORY_STATE[key] = fail + 1;
    return { uid, name: acc.name, ok: okSign, message: msg, balance: balanceAfter };
  } catch (e) {
    IN_MEMORY_STATE[key] = fail + 1;
    return { uid, name: acc.name, ok:false, message:'异常: ' + e.message };
  }
}

// 入口：/api/cron/maintain
async function maintain(ctx) {
  const secret = process.env.RACCOON_CRON_SECRET;
  if (secret) {
    const qKey = ctx.query && (ctx.query.key || ctx.query.token) || '';
    if (qKey !== secret) return util.json(ctx.res, 401, { success:false, error:'未授权' });
  }
  let accountsList = [];
  try { accountsList = await accounts.listAccounts(); } catch(e) {
    return util.json(ctx.res, 500, { success:false, error:'读取账号失败: ' + e.message });
  }
  const results = [];
  for (const acc of accountsList) {
    if (acc && acc._del) continue;         // 跳过墓碑
    const r = await checkinOne(acc);
    results.push(r);
  }
  const okCount = results.filter(r => r.ok).length;
  return util.json(ctx.res, 200, {
    success: true,
    total: accountsList.length,
    ok: okCount,
    results,
  });
}

module.exports = { maintain, checkinOne, ensureToken, tokenExpMs, REFRESH_AHEAD_MS };
