'use strict';
// 零依赖工具集：HTTP 解析、JSON 读写、时间、随机、脱敏
const crypto = require('crypto');

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body_too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function parseJson(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}
function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}
function text(res, code, s, type = 'text/plain; charset=utf-8') {
  res.statusCode = code;
  res.setHeader('Content-Type', type);
  res.end(s);
}
function html(res, code, s) { return text(res, code, s, 'text/html; charset=utf-8'); }
function now() { return Math.floor(Date.now() / 1000); }
function randomToken(len = 32) {
  return crypto.randomBytes(len).toString('hex');
}
// 脱敏：只保留前4位，其余打码
function maskCookie(v) {
  if (!v) return '';
  if (v.length <= 8) return '****';
  return v.slice(0, 4) + '...' + v.slice(-4);
}
// URL-safe base64 无 padding，JWT 用
function b64url(str) {
  return Buffer.from(str).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
// 解析 query 字符串
function parseQuery(q) {
  const out = {};
  if (!q) return out;
  for (const part of q.split('&')) {
    if (!part) continue;
    const i = part.indexOf('=');
    const k = i < 0 ? part : part.slice(0, i);
    const v = i < 0 ? '' : part.slice(i + 1);
    try { out[decodeURIComponent(k)] = decodeURIComponent(v); }
    catch (e) { out[k] = v; }
  }
  return out;
}
// 今天日期字符串 YYYY-MM-DD（本地时区）
function todayStr() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return d.getFullYear() + '-' + mm + '-' + dd;
}
module.exports = { readBody, parseJson, json, text, html, now, randomToken, maskCookie, b64url, parseQuery, todayStr };
