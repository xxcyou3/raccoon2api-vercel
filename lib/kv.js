
'use strict';
// Upstash KV REST 客户端（Vercel 原生注入 KV_REST_API_URL / KV_REST_API_TOKEN）
// 只用 REST，不引第三方包，符合本项目零依赖约束。
//
// 为什么用 KV 而不是 Vercel 环境变量：
//   1) 环境变量 encrypted 类型永远读不回明文，只在部署时烤进 process.env
//   2) Redeploy 沿用旧部署的 env 快照，新加的变量读不到 —— 这就是"重新部署丢号"的根因
//   KV 是运行时读取的持久存储，写进去立刻生效、跨部署/跨实例都在。

const https = require('https');
const http = require('http');

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const PREFIX = process.env.RACCOON_KV_PREFIX || 'raccoon:';

// ---------- 命令计数器（观测用，不含任何逻辑）----------
// Upstash 免费额度按「命令数」计费，看不到实际消耗就只能瞎猜。
// 这里统计本实例生命周期内各类命令的调用次数，供 /api/x/diag 暴露，
// 用来判断哪些高频路径在烧配额。不影响任何读写行为。
const METRICS = { get: 0, set: 0, del: 0, keys: 0, mget: 0, scan: 0, total: 0, errors: 0 };

function metrics() {
  return Object.assign({}, METRICS);
}
function resetMetrics() {
  for (const k of Object.keys(METRICS)) METRICS[k] = 0;
}

function available() {
  return !!(KV_URL && KV_TOKEN);
}

function info() {
  return {
    available: available(),
    urlSet: !!KV_URL,
    tokenSet: !!KV_TOKEN,
    prefix: PREFIX,
  };
}

// 单次 REST 调用：POST {url}/{cmd...}，body 为参数数组
function call(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!available()) return reject(new Error('kv_not_configured'));
    let u;
    try { u = new URL(KV_URL); } catch (e) { return reject(new Error('kv_bad_url')); }
    const body = JSON.stringify(args);
    const isHttps = u.protocol === 'https:';
    const mod = isHttps ? https : http;
    const req = mod.request({
      host: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname.replace(/\/$/, '') + '/',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + KV_TOKEN,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: timeoutMs || 10000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          const err = new Error('kv_http_' + res.statusCode);
          err.status = res.statusCode;
          err.body = text.slice(0, 300);
          reject(err);
        }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('kv_timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ---- 基础命令 ----
async function get(key) {
  METRICS.get++; METRICS.total++;
  const r = await call(['GET', PREFIX + key]);
  return r ? r.result : null;
}

async function set(key, value) {
  METRICS.set++; METRICS.total++;
  const r = await call(['SET', PREFIX + key, String(value)]);
  return !!(r && r.result === 'OK');
}

async function del(key) {
  METRICS.del++; METRICS.total++;
  const r = await call(['DEL', PREFIX + key]);
  return r ? r.result : 0;
}

async function keys(pattern) {
  METRICS.keys++; METRICS.total++;
  const r = await call(['KEYS', PREFIX + (pattern || '*')]);
  const list = (r && r.result) || [];
  return list.map((k) => String(k).slice(PREFIX.length));
}

async function mget(names) {
  if (!names || !names.length) return [];
  METRICS.mget++; METRICS.total++;
  const r = await call(['MGET'].concat(names.map((n) => PREFIX + n)));
  return (r && r.result) || [];
}

// 扫描式列举（keys 在生产环境可能被禁用，用 SCAN 兜底）
async function scan(pattern) {
  const out = [];
  let cursor = '0';
  for (let i = 0; i < 50; i++) {
    METRICS.scan++; METRICS.total++;
    const r = await call(['SCAN', cursor, 'MATCH', PREFIX + (pattern || '*'), 'COUNT', 200]);
    const v = (r && r.result) || [];
    cursor = String(v[0] || '0');
    const arr = v[1] || [];
    for (const k of arr) out.push(String(k).slice(PREFIX.length));
    if (cursor === '0') break;
  }
  return out;
}

// 优先 SCAN，失败再退回 KEYS
async function listKeys(pattern) {
  try { return await scan(pattern); } catch (_) { return await keys(pattern); }
}

module.exports = { available, info, get, set, del, keys, mget, scan, listKeys, PREFIX, metrics, resetMetrics };
