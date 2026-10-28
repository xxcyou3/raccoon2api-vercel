/**
 * 注意：本文件放在 lib 目录，供子模块 require('./logs') 使用
 */
'use strict';
// 日志中心：内存快读 + KV 异步落盘（跨部署/跨实例保留最近 N 条）。
//
// 为什么加 KV：原来纯内存，实例一换日志就清空了。
// 策略：
//   - push 先写内存（同步、零延迟，调用方不用 await）
//   - 同时节流异步 flush 到 KV（最多每 3 秒一次，或积压 ≥10 条）
//   - list 读 KV 与内存的并集（按时间倒序、去重）
const kv = require('./kv');

const MAX = 300;          // KV 与内存各保留最近 300 条
const KV_KEY = 'logs';
const FLUSH_MS = 3000;    // 节流窗口
const FLUSH_BATCH = 10;   // 积压多少条立刻 flush

let buf = [];             // 内存缓冲（新→旧）
let _seq = 0;             // 单调序列号：同毫秒多条日志靠它保证稳定排序
let _pending = 0;         // 待落盘积压数
let _lastFlush = 0;
let _flushing = false;

function useKv() { return kv.available(); }

// 时间倒序；同一毫秒内按自增 seq 倒序，保证「最新一条」永远是真的最新
function cmpDesc(a, b) {
  const dt = Number(b.t || 0) - Number(a.t || 0);
  if (dt !== 0) return dt;
  return Number(b.seq || 0) - Number(a.seq || 0);
}

function push(level, msg, meta) {
  const item = {
    t: Date.now(),
    seq: ++_seq,
    level: String(level || 'info'),
    msg: String(msg == null ? '' : msg),
    meta: meta === undefined ? null : meta,
  };
  buf.push(item);
  if (buf.length > MAX) buf.splice(0, buf.length - MAX);
  _pending++;
  // 积压够多就立刻刷，否则交给节流
  if (_pending >= FLUSH_BATCH) { flush().catch(() => {}); }
  else { scheduleFlush(); }
  return item;
}

let _timer = null;
function scheduleFlush() {
  if (_timer || !useKv()) return;
  const wait = Math.max(0, FLUSH_MS - (Date.now() - _lastFlush));
  _timer = setTimeout(() => {
    _timer = null;
    flush().catch(() => {});
  }, wait);
  if (_timer && typeof _timer.unref === 'function') _timer.unref();
}

// 把内存里最新的 N 条整体写入 KV（简单可靠：整块覆盖，不做增量合并）
async function flush(force) {
  if (!useKv()) return false;
  if (_flushing) return false;
  const now = Date.now();
  if (!force && _pending === 0) return false;
  if (!force && (now - _lastFlush) < FLUSH_MS) { scheduleFlush(); return false; }
  _flushing = true;
  const snapshot = buf.slice(0, MAX);
  try {
    // 先于远端合并：避免多实例互相覆盖丢日志
    let remote = [];
    try {
      const raw = await kv.get(KV_KEY);
      if (raw) { const j = JSON.parse(raw); if (Array.isArray(j)) remote = j; }
    } catch (_) {}
    const seen = new Set();
    const merged = [];
    for (const x of [...snapshot, ...remote]) {
      if (!x || typeof x !== 'object') continue;
      const sig = String(x.t) + '|' + String(x.seq || '') + '|' + String(x.level) + '|' + String(x.msg).slice(0, 80);
      if (seen.has(sig)) continue;
      seen.add(sig);
      merged.push(x);
    }
    merged.sort(cmpDesc);
    const out = merged.slice(0, MAX);
    await kv.set(KV_KEY, JSON.stringify(out));
    _lastFlush = Date.now();
    _pending = 0;
    return true;
  } catch (_) {
    return false;
  } finally {
    _flushing = false;
  }
}

function info(msg, meta) { return push('info', msg, meta); }
function warn(msg, meta) { return push('warn', msg, meta); }
function error(msg, meta) { return push('error', msg, meta); }

// 同步版：只读内存（兼容老的同步调用）
function list(limit) {
  const n = Number(limit) > 0 ? Number(limit) : 200;
  return buf.slice(Math.max(0, buf.length - n)).reverse();
}

// 异步版：KV 与内存并集，面板日志页用这个
async function listAsync(limit) {
  const n = Number(limit) > 0 ? Number(limit) : 200;
  let remote = [];
  if (useKv()) {
    try {
      const raw = await kv.get(KV_KEY);
      if (raw) { const j = JSON.parse(raw); if (Array.isArray(j)) remote = j; }
    } catch (_) {}
  }
  const seen = new Set();
  const merged = [];
  for (const x of [...buf.slice().reverse(), ...remote]) {
    if (!x || typeof x !== 'object') continue;
    const sig = String(x.t) + '|' + String(x.seq || '') + '|' + String(x.level) + '|' + String(x.msg).slice(0, 80);
    if (seen.has(sig)) continue;
    seen.add(sig);
    merged.push(x);
  }
  merged.sort((a, b) => Number(b.t || 0) - Number(a.t || 0));
  return merged.slice(0, n);
}

async function clear() {
  buf = [];
  _pending = 0;
  if (!useKv()) return true;
  try { await kv.del(KV_KEY); return true; } catch (_) { return false; }
}

module.exports = {
  push, info, warn, error, list, listAsync, flush, clear, MAX, KV_KEY,
  backend: () => (useKv() ? 'kv' : 'memory'),
};
