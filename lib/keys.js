'use strict';
// 网关 API Key 管理：存 RACCOON_API_KEYS（JSON 数组），每次新建/删除同步写 Vercel env。
const crypto = require('crypto');
const envstore = require('./envstore');

const ENV_KEY = 'RACCOON_API_KEYS';

function load() {
  const raw = process.env[ENV_KEY] || '';
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter(k => k && k.key) : [];
  } catch (_) { return []; }
}

function save(list) {
  return envstore.set(ENV_KEY, JSON.stringify(list));
}

function mask(k) {
  const s = String(k || '');
  if (s.length <= 10) return s.slice(0, 3) + '***';
  return s.slice(0, 6) + '...' + s.slice(-4);
}

function listPublic() {
  const out = load().map(k => ({ id: k.id, name: k.name || '', key: mask(k.key), created: k.created || 0, enabled: k.enabled !== false }));
  const legacy = process.env.RACCOON_API_TOKEN || '';
  if (legacy) out.push({ id: 'env:RACCOON_API_TOKEN', name: '环境变量 RACCOON_API_TOKEN', key: mask(legacy), created: 0, enabled: true, legacy: true });
  return out;
}

async function create(name) {
  const list = load();
  const key = 'rk_' + crypto.randomBytes(18).toString('hex');
  const item = { id: 'k_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'), name: String(name || '未命名 Key'), key, created: Date.now(), enabled: true };
  list.push(item);
  const r = await save(list);
  return { ok: !!r.ok, item: { id: item.id, name: item.name, key, created: item.created }, synced: !!r.ok && !r.local, local: !!r.local };
}

async function remove(id) {
  if (String(id).startsWith('env:')) return { ok: false, error: '环境变量里的 Key 请在“设置”页修改 RACCOON_API_TOKEN' };
  const list = load();
  const next = list.filter(k => k.id !== id);
  if (next.length === list.length) return { ok: false, error: 'Key 不存在' };
  const r = await save(next);
  return { ok: !!r.ok, synced: !!r.ok && !r.local };
}

function isValid(key) {
  const s = String(key || '');
  if (!s) return false;
  if (process.env.RACCOON_API_TOKEN && s === process.env.RACCOON_API_TOKEN) return true;
  if (process.env.RACCOON_ADMIN_TOKEN && s === process.env.RACCOON_ADMIN_TOKEN) return true;
  return load().some(k => k.key === s && k.enabled !== false);
}

module.exports = { list: load, listPublic, create, remove, isValid, ENV_KEY, mask };
