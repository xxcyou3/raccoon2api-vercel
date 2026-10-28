/**
 * 注意：本文件放在 lib 目录，供子模块 require('#keys') 使用
 */
'use strict';
// 网关 API Key 管理 —— KV 优先（跨部署/跨实例持久），环境变量只作只读兼容源。
//
// 为什么改 KV：原来存 Vercel 环境变量，但
//   1) 写进 env 后当前实例的 process.env 不会更新 → 新建 Key 立刻用不了；
//   2) RS Redeploy 沿用旧 env 快照 → Key 会“丢”；
//   3) encrypted 类型读不回明文。
//
// 存储形态（KV）：key = raccoon:keys，value = JSON 数组
//   [{ id, name, key, created, enabled }]

const crypto = require('crypto');
const kv = require('./kv');

const KV_KEY = 'keys';
const ENV_KEY = 'RACCOON_API_KEYS';
let _local = [];   // 无 KV 时（本机开发）的内存兜底

function useKv() {
  return kv.available();
}

// 读取 key 列表：KV 优先，其次环境变量（老数据兼容），最后内存
function load() {
  if (useKv()) {
    // 同步返回不可行，KV 读是 async；listPublic/create/remove 都走 async 版本
    // 这里返回内存镜像，由 refresh() 异步填充
    return _local.slice();
  }
  const raw = process.env[ENV_KEY] || '';
  if (!raw) return _local.slice();
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter(k => k && k.key) : [];
  } catch (_) { return _local.slice(); }
}

// 带 TTL 的预热：新实例/冷启动后首次校验前必须先拉一次 KV，
// 否则内存镜像为空、KV 里的 Key 会被误判无效。30 秒内复用，避免每请求都读 KV。
let _lastLoad = 0;
async function ensureLoaded(maxAgeMs) {
  const age = Date.now() - _lastLoad;
  const ttl = Number(maxAgeMs == null ? 30000 : maxAgeMs);
  if (_lastLoad && age >= 0 && age < ttl) return _local;
  const list = await refresh();
  _lastLoad = Date.now();
  return list;
}

// 从权威存储异步刷新到内存镜像
async function refresh() {
  if (!useKv()) { _local = load(); return _local; }
  let raw = null;
  try { raw = await kv.get(KV_KEY); } catch (_) { raw = null; }
  let arr = [];
  if (raw) {
    try {
      const j = JSON.parse(raw);
      if (Array.isArray(j)) arr = j.filter(k => k && k.key);
    } catch (_) { arr = []; }
  }
  // KV 空时回退到环境变量的老数据（一次性兼容，不自动写入 KV）
  if (!arr.length) {
    const envRaw = process.env[ENV_KEY] || '';
    if (envRaw) {
      try {
        const j2 = JSON.parse(envRaw);
        if (Array.isArray(j2)) arr = j2.filter(k => k && k.key);
      } catch (_) {}
    }
  }
  _local = arr;
  return _local;
}

async function persist(list) {
  _local = list.slice();
  _lastLoad = Date.now();
  if (!useKv()) return { ok: true, local: true };
  try {
    await kv.set(KV_KEY, JSON.stringify(list));
    return { ok: true, backend: 'kv' };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

function mask(k) {
  const s = String(k || '');
  if (s.length <= 10) return s.slice(0, 3) + '***';
  return s.slice(0, 6) + '...' + s.slice(-4);
}

async function listPublic() {
  const list = await refresh();
  const out = list.map(k => ({
    id: k.id, name: k.name || '', key: mask(k.key),
    created: k.created || 0, enabled: k.enabled !== false,
  }));
  const legacy = process.env.RACCOON_API_TOKEN || '';
  if (legacy) {
    out.push({
      id: 'env:RACCOON_API_TOKEN', name: '环境变量 RACCOON_API_TOKEN',
      key: mask(legacy), created: 0, enabled: true, legacy: true,
    });
  }
  return out;
}

async function create(name) {
  const list = await refresh();
  const key = 'rk_' + crypto.randomBytes(18).toString('hex');
  const item = {
    id: 'k_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'),
    name: String(name || '未命名 Key'),
    key, created: Date.now(), enabled: true,
  };
  list.push(item);
  const r = await persist(list);
  return {
    ok: !!r.ok, item: { id: item.id, name: item.name, key, created: item.created },
    synced: !!r.ok && !r.local, local: !!r.local, backend: r.backend || null,
    error: r.error || null,
  };
}

async function remove(id) {
  if (String(id).startsWith('env:')) {
    return { ok: false, error: '环境变量里的 Key 请在「设置」页修改 RACCOON_API_TOKEN' };
  }
  const list = await refresh();
  const next = list.filter(k => k.id !== id);
  if (next.length === list.length) return { ok: false, error: 'Key 不存在' };
  const r = await persist(next);
  return { ok: !!r.ok, synced: !!r.ok && !r.local, error: r.error || null };
}

// 校验 Key 是否有效（同步，尽量不 I/O）
function isValid(key) {
  const s = String(key || '');
  if (!s) return false;
  if (process.env.RACCOON_API_TOKEN && s === process.env.RACCOON_API_TOKEN) return true;
  if (process.env.RACCOON_ADMIN_TOKEN && s === process.env.RACCOON_ADMIN_TOKEN) return true;
  // 内存镜像命中（refresh() 已异步填充过）
  if (_local.some(k => k.key === s && k.enabled !== false)) return true;
  // 环境变量里的老 keys JSON
  const envRaw = process.env[ENV_KEY] || '';
  if (envRaw) {
    try {
      const arr = JSON.parse(envRaw);
      if (Array.isArray(arr) && arr.some(k => k.key === s && k.enabled !== false)) return true;
    } catch (_) {}
  }
  return false;
}

module.exports = {
  load, refresh, ensureLoaded, listPublic, create, remove, isValid, mask,
  ENV_KEY, KV_KEY,
  backend: () => (useKv() ? 'kv' : 'memory'),
};
