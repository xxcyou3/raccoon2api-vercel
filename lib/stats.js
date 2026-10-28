'use strict';
// 调用统计（KV 持久化）：按天聚合，记录每次网关调用的账号/模型/token/耗时/成败。
//
// 存储结构（每个自然日一个 key，读写都是「读-改-写」，量小无需原子）：
//   raccoon:stats:day:YYYY-MM-DD = {
//     day, calls, okCalls, failCalls, promptTokens, completionTokens, totalTokens, ms,
//     byAccount: { <uid>: { name, calls, okCalls, failCalls, tokens, ms } },
//     byModel:   { <model>: { calls, okCalls, failCalls, tokens } },
//     byHour:    [ {calls, tokens}, ... 24 项 ]
//   }
//
// KV 不可用时全部降级为内存（仅本实例可见），不影响主链路。
const kv = require('./kv');

const PREFIX = 'raccoon:stats:day:';
const mem = new Map(); // day -> obj（KV 不可用时的兜底 & 当前实例缓存）

function dayKey(d) {
  return PREFIX + d;
}

function today() {
  // 统一用北京时间（UTC+8）分天，跟用户的直觉一致
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  return now.toISOString().slice(0, 10);
}

function emptyDay(day) {
  return {
    day,
    calls: 0, okCalls: 0, failCalls: 0,
    promptTokens: 0, completionTokens: 0, totalTokens: 0, ms: 0,
    byAccount: {}, byModel: {},
    byHour: Array.from({ length: 24 }, () => ({ calls: 0, tokens: 0 })),
  };
}

async function readDay(day) {
  if (mem.has(day)) return mem.get(day);
  let obj = null;
  try {
    if (kv.available()) {
      const raw = await kv.get(dayKey(day));
      if (raw) obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    }
  } catch (_) { obj = null; }
  const out = obj && obj.day ? obj : emptyDay(day);
  // 补齐可能缺失的字段（旧数据兼容）
  if (!Array.isArray(out.byHour) || out.byHour.length !== 24) out.byHour = emptyDay(day).byHour;
  if (!out.byAccount) out.byAccount = {};
  if (!out.byModel) out.byModel = {};
  mem.set(day, out);
  return out;
}

async function writeDay(day, obj) {
  mem.set(day, obj);
  try {
    if (kv.available()) await kv.set(dayKey(day), JSON.stringify(obj));
  } catch (_) { /* KV 写失败不影响主链路 */ }
}

// 记录一次调用。失败也不抛错——统计绝不能拖垮网关。
async function record(rec) {
  try {
    const day = today();
    const obj = await readDay(day);
    const ok = rec.ok !== false;
    const pt = Number(rec.promptTokens) || 0;
    const ct = Number(rec.completionTokens) || 0;
    const tt = Number(rec.totalTokens) || (pt + ct);
    const ms = Number(rec.ms) || 0;

    obj.calls += 1;
    if (ok) obj.okCalls += 1; else obj.failCalls += 1;
    obj.promptTokens += pt;
    obj.completionTokens += ct;
    obj.totalTokens += tt;
    obj.ms += ms;

    const uid = String(rec.uid || rec.account || 'unknown');
    const an = obj.byAccount[uid] || (obj.byAccount[uid] = {
      name: rec.name || uid, calls: 0, okCalls: 0, failCalls: 0, tokens: 0, ms: 0,
    });
    if (rec.name) an.name = rec.name;
    an.calls += 1;
    if (ok) an.okCalls += 1; else an.failCalls += 1;
    an.tokens += tt;
    an.ms += ms;

    const model = String(rec.model || 'unknown');
    const mn = obj.byModel[model] || (obj.byModel[model] = {
      calls: 0, okCalls: 0, failCalls: 0, tokens: 0,
    });
    mn.calls += 1;
    if (ok) mn.okCalls += 1; else mn.failCalls += 1;
    mn.tokens += tt;

    // 小时桶：北京时间
    const hh = new Date(Date.now() + 8 * 3600 * 1000).getUTCHours();
    if (obj.byHour[hh]) { obj.byHour[hh].calls += 1; obj.byHour[hh].tokens += tt; }

    await writeDay(day, obj);
    return true;
  } catch (_) {
    return false;
  }
}

// 拉取最近 n 天（含今天），返回按天倒序的数组 + 汇总
async function summary(days) {
  const n = Math.min(Math.max(Number(days) || 7, 1), 60);
  const today_ = today();
  const base = new Date(today_ + 'T00:00:00Z');
  const list = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(base.getTime() - i * 86400000).toISOString().slice(0, 10);
    let obj = null;
    try { obj = await readDay(d); } catch (_) { obj = null; }
    list.push(obj || emptyDay(d));
  }

  const total = emptyDay('total');
  const accMap = {}, modMap = {};
  const byHour = Array.from({ length: 24 }, () => ({ calls: 0, tokens: 0 }));
  for (const o of list) {
    total.calls += o.calls || 0;
    total.okCalls += o.okCalls || 0;
    total.failCalls += o.failCalls || 0;
    total.promptTokens += o.promptTokens || 0;
    total.completionTokens += o.completionTokens || 0;
    total.totalTokens += o.totalTokens || 0;
    total.ms += o.ms || 0;
    for (const [uid, a] of Object.entries(o.byAccount || {})) {
      const t = accMap[uid] || (accMap[uid] = { name: a.name || uid, calls: 0, okCalls: 0, failCalls: 0, tokens: 0, ms: 0 });
      if (a.name) t.name = a.name;
      t.calls += a.calls || 0; t.okCalls += a.okCalls || 0; t.failCalls += a.failCalls || 0;
      t.tokens += a.tokens || 0; t.ms += a.ms || 0;
    }
    for (const [m, x] of Object.entries(o.byModel || {})) {
      const t = modMap[m] || (modMap[m] = { calls: 0, okCalls: 0, failCalls: 0, tokens: 0 });
      t.calls += x.calls || 0; t.okCalls += x.okCalls || 0; t.failCalls += x.failCalls || 0; t.tokens += x.tokens || 0;
    }
    for (let h = 0; h < 24; h++) {
      const s = (o.byHour || [])[h];
      if (s) { byHour[h].calls += s.calls || 0; byHour[h].tokens += s.tokens || 0; }
    }
  }
  total.byAccount = accMap;
  total.byModel = modMap;
  total.byHour = byHour;

  return {
    backend: kv.available() ? 'kv' : 'memory',
    days: list.map(o => ({
      day: o.day, calls: o.calls, okCalls: o.okCalls, failCalls: o.failCalls,
      tokens: o.totalTokens, promptTokens: o.promptTokens, completionTokens: o.completionTokens,
      ms: o.ms,
    })).reverse(),   // 从旧到新，方便画图
    total,
  };
}

// 供账号轮询使用：取某账号今日的调用数与失败数
async function accountLoad(uid) {
  try {
    const obj = await readDay(today());
    const a = obj.byAccount[String(uid)];
    return a ? { calls: a.calls, failCalls: a.failCalls, ms: a.ms } : { calls: 0, failCalls: 0, ms: 0 };
  } catch (_) {
    return { calls: 0, failCalls: 0, ms: 0 };
  }
}

module.exports = { record, summary, accountLoad, today, emptyDay };
