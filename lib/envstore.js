'use strict';
// Vercel 环境变量读写（用于“设置”页与 Key 同步）。
// 读：process.env（部署时注入的明文）
// 写：Vercel API upsert（encrypted），下次部署/实例冷启动生效
const net = require('./net');

function team() {
  const t = process.env.VERCEL_TEAM_ID;
  return t ? ('&teamId=' + encodeURIComponent(t)) : '';
}
function projectId() {
  return process.env.VERCEL_PROJECT_ID || '';
}
function canWrite() {
  return !!(process.env.VERCEL_TOKEN && projectId());
}

function get(key) {
  const v = process.env[key];
  return v === undefined ? '' : String(v);
}

async function set(key, value) {
  if (!canWrite()) {
    // 本机/无凭据：只更新当前进程，便于测试
    process.env[key] = String(value == null ? '' : value);
    return { ok: true, local: true };
  }
  const body = [{
    key,
    value: String(value == null ? '' : value),
    type: 'encrypted',
    target: ['production', 'preview', 'development'],
  }];
  const r = await net.request({
    base: 'https://api.vercel.com',
    path: '/v10/projects/' + projectId() + '/env?upsert=true' + team(),
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.VERCEL_TOKEN, 'Content-Type': 'application/json' },
    body,
    timeoutMs: 25000,
  });
  const ok = r && r.status >= 200 && r.status < 300;
  if (ok) process.env[key] = String(value == null ? '' : value);
  return { ok, status: r && r.status, data: (r && r.data) || null };
}

async function remove(key) {
  if (!canWrite()) { delete process.env[key]; return { ok: true, local: true }; }
  const list = await net.request({
    base: 'https://api.vercel.com',
    path: '/v9/projects/' + projectId() + '/env?perPage=100' + team(),
    method: 'GET',
    headers: { Authorization: 'Bearer ' + process.env.VERCEL_TOKEN },
    timeoutMs: 25000,
  });
  let envs = [];
  if (list && list.data) envs = list.data.envs || list.data || [];
  const hits = (Array.isArray(envs) ? envs : []).filter(e => e && e.key === key);
  let ok = true;
  for (const h of hits) {
    const r = await net.request({
      base: 'https://api.vercel.com',
      path: '/v9/projects/' + projectId() + '/env/' + h.id + team(),
      method: 'DELETE',
      headers: { Authorization: 'Bearer ' + process.env.VERCEL_TOKEN },
      timeoutMs: 20000,
    });
    ok = ok && r && r.status >= 200 && r.status < 300;
  }
  return { ok, removed: hits.length };
}

module.exports = { get, set, remove, canWrite };
