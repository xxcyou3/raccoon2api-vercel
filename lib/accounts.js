
'use strict';
// 账号存储层 —— KV 优先，环境变量只作一次性迁移源，文件后端兜底（本机开发）。
//
// 为什么改成 KV：
//   1) Vercel 环境变量 encrypted 类型永远读不回明文（?decrypt=true 也无效），
//      运行时只能靠"部署时烤进 process.env"的快照。
//   2) Redeploy 沿用那次部署的 env 快照 —— 新加的账号变量读不到，
//      这就是"重新部署后新账号丢失、变回老三个号"的根因。
//   3) 环境变量写入只有 POST 创建，key 已存在时静默失败，
//      导致 refreshToken 轮换后新票存不回去。
//   KV 是运行时读写，写进去立刻生效、跨部署跨实例都在，也没有密文问题。
//
// 存储形态（KV）：
//   key   = raccoon:acct:<envKey(uid)>
//   value = JSON 字符串 { v, UserID, name, accessToken, refreshToken, expiryMs, ..., _mtime }
//   删除写墓碑 { _del: 1, _mtime }，listAccounts 跳过墓碑，purgeTombstones 可物理清。

const fs = require('fs');
const path = require('path');
const net = require('./net');
const kv = require('./kv');

const PREFIX = 'RACCOON_ACCT_';
const TOMBSTONE = '_del';
const ALL_TARGETS = ['production', 'preview', 'development'];
const KV_TAG = 'acct:';

// env 变量名只能 A-Z0-9_，uid 里的连字符必须去掉（否则写环境变量会 400）
function envKey(uid) {
  const clean = String(uid || '').replace(/[^A-Za-z0-9]/g, '');
  return PREFIX + (clean || 'unknown');
}

function kvKey(uid) {
  return KV_TAG + envKey(uid);
}

// 本机（无 KV_REST_API_URL）走文件，方便本地调试
function useKv() {
  return kv.available();
}
function useEnvBackend() {
  return !!process.env.VERCEL_TOKEN && !!process.env.VERCEL_PROJECT_ID && !useKv();
}
function dataFile() {
  return process.env.RACCOON_DATA_FILE || '/tmp/data/accounts.json';
}

// ---------- KV 后端 ----------
async function kvReadAll() {
  const names = await kv.listKeys(KV_TAG + '*');
  if (!names || !names.length) return [];
  const out = [];
  // 分批 mget，避免单次请求过大
  const BATCH = 40;
  for (let i = 0; i < names.length; i += BATCH) {
    const slice = names.slice(i, i + BATCH);
    let vals = [];
    try { vals = await kv.mget(slice); } catch (_) { vals = []; }
    if (!vals || vals.length !== slice.length) {
      // mget 失败就逐个 get
      for (const n of slice) {
        try {
          const v = await kv.get(n);
          if (v) { try { out.push(JSON.parse(v)); } catch (_) {} }
        } catch (_) {}
      }
      continue;
    }
    for (let j = 0; j < slice.length; j++) {
      const raw = vals[j];
      if (!raw) continue;
      try { out.push(JSON.parse(raw)); } catch (_) {}
    }
  }
  return out;
}

async function kvSave(account) {
  const uid = account.UserID || account.uid || account.userId;
  if (!uid) throw new Error('account_missing_uid');
  const key = envKey(uid);
  const rec = Object.assign({}, account, {
    v: account.v || 2,
    UserID: uid,
    _mtime: Date.now(),
  });
  delete rec[TOMBSTONE];
  await kv.set(kvKey(uid), JSON.stringify(rec));
  memSet(rec, key);
  return rec;
}

async function kvDelete(uid) {
  await kv.set(kvKey(uid), JSON.stringify({ v: 2, UserID: uid, [TOMBSTONE]: 1, _mtime: Date.now() }));
  memCache.delete(envKey(uid));
}

// ---------- 环境变量后端（仅迁移用） ----------
function teamQS(prefix) {
  const t = process.env.VERCEL_TEAM_ID;
  return prefix + (t ? (prefix.includes('?') ? '&' : '?') + 'teamId=' + encodeURIComponent(t) : '');
}

function parseApi(r) {
  if (!r) return null;
  if (typeof r === 'string') { try { return JSON.parse(r); } catch (_) { return null; } }
  if (r.rawBody) { try { return JSON.parse(r.rawBody); } catch (_) { return null; } }
  if (r.data) return r.data;
  return r;
}

async function vercelApi(method, urlPath, payload) {
  const base = 'https://api.vercel.com';
  const r = await net.request({
    base,
    path: urlPath,
    method,
    headers: {
      'Authorization': 'Bearer ' + (process.env.VERCEL_TOKEN || ''),
      'Content-Type': 'application/json',
    },
    body: payload === undefined ? undefined : payload,
    timeoutMs: 20000,
    raw: true,
  });
  return parseApi(r);
}

async function listEnvRecords() {
  const proj = process.env.VERCEL_PROJECT_ID;
  if (!proj || !process.env.VERCEL_TOKEN) return [];
  const r = await vercelApi('GET', teamQS('/v10/projects/' + proj + '/env'));
  const d = parseApi(r) || {};
  const arr = Array.isArray(d) ? d : (d.envs || []);
  return arr.filter((e) => String(e.key || '').startsWith(PREFIX));
}

// 迁移源之一：process.env（部署时注入的明文，只有现值、没有历史）
function readProcessEnvAccounts() {
  const out = [];
  for (const k of Object.keys(process.env)) {
    if (!k.startsWith(PREFIX)) continue;
    const raw = process.env[k];
    if (!raw) continue;
    try {
      const obj = JSON.parse(raw);
      if (obj && typeof obj === 'object' && (obj.UserID || obj.accessToken)) out.push(obj);
    } catch (_) {}
  }
  return out;
}

// 迁移源之二：env API 里 type=plain 的记录能读回明文
async function readPlainEnvAccounts() {
  const recs = await listEnvRecords();
  const out = [];
  for (const e of recs) {
    if (e.type !== 'plain') continue;
    const raw = e.value;
    if (!raw) continue;
    try {
      const obj = JSON.parse(raw);
      if (obj && typeof obj === 'object' && (obj.UserID || obj.accessToken)) out.push(obj);
    } catch (_) {}
  }
  return out;
}

// ---------- 内存缓冲（同一实例写入后立刻可读） ----------
const memCache = new Map();
function memSet(account, key) {
  memCache.set(key || envKey(account.UserID || account.uid), account);
}

// ---------- 文件后端（本机） ----------
function readFileAll() {
  try { return JSON.parse(fs.readFileSync(dataFile(), 'utf8')); }
  catch (_) { return {}; }
}
function writeFileAll(map) {
  fs.mkdirSync(path.dirname(dataFile()), { recursive: true });
  const tmp = dataFile() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(map, null, 2));
  fs.renameSync(tmp, dataFile());
}
function fileRemove(uid) {
  const map = readFileAll();
  delete map[envKey(uid)];
  writeFileAll(map);
}

// ---------- 统一读 ----------
async function readAll() {
  const map = new Map();   // envKey -> account
  const put = (a) => {
    if (!a) return;
    const uid = a.UserID || a.uid || a.userId;
    if (!uid) return;
    const k = envKey(uid);
    const prev = map.get(k);
    // 墓碑优先：_del 存在就保留墓碑，避免被别的来源复活
    if (prev && prev[TOMBSTONE] && !a[TOMBSTONE]) return;
    if (prev && !prev[TOMBSTONE] && a[TOMBSTONE]) { map.set(k, a); return; }
    if (prev && (prev._mtime || 0) > (a._mtime || 0) && !a[TOMBSTONE]) return;
    map.set(k, a);
  };

  if (useKv()) {
    try { (await kvReadAll()).forEach(put); } catch (_) {}
  } else if (useEnvBackend()) {
    try { (await readPlainEnvAccounts()).forEach(put); } catch (_) {}
  }

  // process.env 作为兜底基线（KV 不可用或迁移前的老数据）
  readProcessEnvAccounts().forEach(put);

  // 本机文件
  if (!useKv()) {
    const f = readFileAll();
    for (const k of Object.keys(f)) put(f[k]);
  }

  // 内存缓冲最后覆盖（本实例刚写的更新）
  for (const a of memCache.values()) {
    const k = envKey(a.UserID || a.uid);
    const prev = map.get(k);
    if (!prev || (a._mtime || 0) >= (prev._mtime || 0)) map.set(k, a);
  }

  return Array.from(map.values());
}

async function listAccounts() {
  const all = await readAll();
  return all
    .filter((a) => a && !a[TOMBSTONE])
    .filter((a) => a.UserID || a.uid)
    .sort((x, y) => (y._mtime || 0) - (x._mtime || 0));
}

async function getAccount(uid) {
  if (!uid) return null;
  const key = envKey(uid);
  const want = String(uid);
  const all = await readAll();
  const hit = all.find((a) => {
    const u = a.UserID || a.uid || a.userId;
    return u && (String(u) === want || envKey(u) === key);
  });
  if (!hit || hit[TOMBSTONE]) return null;
  return hit;
}

async function saveAccount(account) {
  if (!account) throw new Error('no_account');
  const uid = account.UserID || account.uid || account.userId;
  if (!uid) throw new Error('account_missing_uid');
  const rec = Object.assign({}, account, { UserID: uid, v: account.v || 2, _mtime: Date.now() });
  delete rec[TOMBSTONE];

  if (useKv()) {
    await kvSave(rec);
    return rec;
  }
  if (useEnvBackend()) {
    // 老路径：写 plain 环境变量（先删后建，避免 key 已存在时静默失败）
    try {
      const recs = await listEnvRecords();
      const key = envKey(uid);
      for (const e of recs) {
        if (e.key !== key) continue;
        await vercelApi('DELETE', teamQS('/v9/projects/' + process.env.VERCEL_PROJECT_ID + '/env/' + e.id));
      }
      await vercelApi('POST', teamQS('/v10/projects/' + process.env.VERCEL_PROJECT_ID + '/env'), {
        key,
        value: JSON.stringify(rec),
        type: 'plain',
        target: ALL_TARGETS,
      });
    } catch (_) {}
    memSet(rec, envKey(uid));
    return rec;
  }
  // 文件后端
  const map = readFileAll();
  map[envKey(uid)] = rec;
  writeFileAll(map);
  memSet(rec, envKey(uid));
  return rec;
}

async function deleteAccount(uid) {
  if (!uid) return false;
  if (useKv()) {
    await kvDelete(uid);
    return true;
  }
  if (useEnvBackend()) {
    try {
      const recs = await listEnvRecords();
      const key = envKey(uid);
      for (const e of recs) {
        if (e.key !== key) continue;
        await vercelApi('DELETE', teamQS('/v9/projects/' + process.env.VERCEL_PROJECT_ID + '/env/' + e.id));
      }
    } catch (_) {}
    memCache.delete(envKey(uid));
    return true;
  }
  fileRemove(uid);
  memCache.delete(envKey(uid));
  return true;
}

// 迁移：把环境变量里的账号搬进 KV（幂等，重复跑安全）
async function syncAllEnv() {
  const collected = [];
  readProcessEnvAccounts().forEach((a) => collected.push(a));
  try { (await readPlainEnvAccounts()).forEach((a) => collected.push(a)); } catch (_) {}

  const seen = new Map();
  for (const a of collected) {
    const uid = a.UserID || a.uid || a.userId;
    if (!uid) continue;
    const k = envKey(uid);
    const prev = seen.get(k);
    if (!prev || (a._mtime || 0) > (prev._mtime || 0)) seen.set(k, a);
  }

  const result = { backend: useKv() ? 'kv' : (useEnvBackend() ? 'env' : 'file'), migrated: 0, skipped: 0, items: [] };
  for (const [k, a] of seen) {
    try {
      const existing = useKv() ? await kv.get(kvKey(a.UserID || a.uid)) : null;
      if (existing) {
        let cur = null;
        try { cur = JSON.parse(existing); } catch (_) {}
        if (cur && !cur[TOMBSTONE] && (cur._mtime || 0) >= (a._mtime || 0)) {
          result.skipped++;
          result.items.push({ key: k, status: 'kept' });
          continue;
        }
      }
      if (useKv()) {
        await kvSave(a);
      } else {
        await saveAccount(a);
      }
      result.migrated++;
      result.items.push({ key: k, status: 'migrated', name: a.name || '' });
    } catch (e) {
      result.items.push({ key: k, status: 'err', error: String(e.message || e).slice(0, 120) });
    }
  }
  return result;
}

// 物理清除墓碑
async function purgeTombstones() {
  let removed = 0;
  if (useKv()) {
    const names = await kv.listKeys(KV_TAG + '*');
    for (const n of names) {
      try {
        const v = await kv.get(n);
        if (!v) continue;
        const o = JSON.parse(v);
        if (o && o[TOMBSTONE]) { await kv.del(n); removed++; }
      } catch (_) {}
    }
    return removed;
  }
  const all = await readAll();
  for (const a of all) {
    if (!a[TOMBSTONE]) continue;
    const uid = a.UserID || a.uid;
    if (uid) { await deleteAccount(uid); removed++; }
  }
  return removed;
}

module.exports = {
  listAccounts, getAccount, saveAccount, deleteAccount, purgeTombstones,
  syncAllEnv, envKey,
  backend: () => (useKv() ? 'kv' : (useEnvBackend() ? 'env' : 'file')),
  kvInfo: () => kv.info(),
};
