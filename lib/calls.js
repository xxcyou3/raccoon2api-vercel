'use strict';
// 调用记录（KV 持久化最近 N 条）：每次网关调用一条，含模型 / tokens / 缓存命中 / 成败 / 账号 / 耗时。
//
// 为什么要单独一个模块而不是塞进 stats：
//   stats 是「按天聚合」的计数器，回答不了「这一次调用成功没成功、用的哪个模型」。
//   调用记录需要保序、按时间倒序展示，用环形缓冲最合适。
//
// KV 消耗控制（关键）：沿用 stats 的节流思路 ——
//   每次 add() 只改内存（0 次 KV），累积够 N 条或距上次刷盘满 M 秒才写一次 KV。
//   读取（list）前先强制刷盘，保证面板看到的是最新。
//
// KV 不可用时全部降级为内存（仅本实例可见），不影响主链路。
const kv = require('./kv');

const KEY = 'calls:ring';        // kv.js 会统一加 raccoon: 前缀
const MAX = 80;                  // 最多保留 80 条（够看最近的，又不至于把 KV 撑大）
const FLUSH_MIN_COUNT = 8;       // 累积 8 条刷一次
const FLUSH_MIN_MS = 20000;      // 或距上次刷盘满 20 秒

let _buf = [];                   // 本实例最新的记录（时间正序，最旧在前）
let _loaded = false;             // 是否已从 KV 加载过历史
let _dirty = false;
let _pending = 0;
let _lastFlush = 0;
let _flushCount = 0;

function clamp(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n > 2000000 ? 0 : Math.round(n);
}

// 从 KV 加载历史记录（只在第一次读取时做，之后靠内存）
async function ensureLoaded() {
  if (_loaded) return;
  _loaded = true;
  try {
    if (!kv.available()) return;
    const raw = await kv.get(KEY);
    if (!raw) return;
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (Array.isArray(arr) && arr.length) {
      // KV 里的历史 + 本实例已产生的（若加载前就有 add 进来）
      const seen = new Set(_buf.map(r => r.id));
      const merged = arr.filter(r => r && !seen.has(r.id)).concat(_buf);
      merged.sort((a, b) => (a.t || 0) - (b.t || 0));
      _buf = merged.slice(-MAX);
    }
  } catch (_) { /* 加载失败就当没有历史 */ }
}

let _seq = 0;
function nextId() {
  _seq += 1;
  return Date.now().toString(36) + '-' + _seq.toString(36);
}

// 写盘（force=true 无视阈值）
async function flush(force) {
  if (!_dirty) return false;
  if (!force && _pending < FLUSH_MIN_COUNT && (Date.now() - _lastFlush) < FLUSH_MIN_MS) return false;
  const snapshot = JSON.stringify(_buf.slice(-MAX));
  try {
    if (kv.available()) await kv.set(KEY, snapshot);
    _dirty = false;
    _pending = 0;
    _lastFlush = Date.now();
    _flushCount += 1;
    return true;
  } catch (_) {
    return false;   // 失败保留 dirty，下次再试
  }
}

// 追加一条调用记录。只改内存，绝不拖慢主链路。
async function add(rec) {
  try {
    await ensureLoaded();
    const pt = clamp(rec.promptTokens);
    const ct = clamp(rec.completionTokens);
    const cc = clamp(rec.cachedTokens);
    const tt = clamp(rec.totalTokens) || (pt + ct);
    const ms = (() => { const n = Number(rec.ms); return Number.isFinite(n) && n >= 0 && n < 3600000 ? Math.round(n) : 0; })();
    const item = {
      id: nextId(),
      t: Date.now(),
      ok: rec.ok !== false,
      uid: String(rec.uid || rec.account || ''),
      name: String(rec.name || ''),
      model: String(rec.model || 'unknown'),
      pt, ct, cc, tt, ms,
      stream: !!rec.stream,
      est: !!rec.estimated,
      err: rec.err ? String(rec.err).slice(0, 160) : '',
    };
    _buf.push(item);
    if (_buf.length > MAX) _buf = _buf.slice(-MAX);
    _dirty = true;
    _pending += 1;
    // 达到阈值就刷盘（不 await 结果，失败下次再试）
    if (_pending >= FLUSH_MIN_COUNT) { flush(false).catch(() => {}); }
    return item;
  } catch (_) {
    return null;
  }
}

// 读取最近记录（时间倒序 = 最新在前）。读取前强制刷盘，保证不滞后。
async function list(limit) {
  await ensureLoaded();
  try { await flush(true); } catch (_) {}
  const n = Number(limit) > 0 ? Math.min(Number(limit), MAX) : 40;
  return _buf.slice(-n).reverse();
}

function info() {
  return { loaded: _loaded, size: _buf.length, max: MAX, dirty: _dirty, pending: _pending, flushes: _flushCount, minCount: FLUSH_MIN_COUNT, minMs: FLUSH_MIN_MS };
}

async function clear() {
  _buf = [];
  _dirty = false;
  _pending = 0;
  try { if (kv.available()) await kv.del(KEY); } catch (_) {}
  return true;
}

module.exports = { add, list, flush, info, clear, MAX };
