'use strict';
// 内存日志中心（每实例独立，最近 500 条），供后台“日志”页查看。
const MAX = 500;
const buf = [];

function push(level, msg, meta) {
  const item = {
    t: Date.now(),
    level: String(level || 'info'),
    msg: String(msg == null ? '' : msg),
    meta: meta === undefined ? null : meta,
  };
  buf.push(item);
  if (buf.length > MAX) buf.splice(0, buf.length - MAX);
  return item;
}

function info(msg, meta) { return push('info', msg, meta); }
function warn(msg, meta) { return push('warn', msg, meta); }
function error(msg, meta) { return push('error', msg, meta); }

function list(limit) {
  const n = Number(limit) > 0 ? Number(limit) : 200;
  return buf.slice(Math.max(0, buf.length - n)).reverse();
}

function clear() { buf.length = 0; }

module.exports = { push, info, warn, error, list, clear, MAX };
