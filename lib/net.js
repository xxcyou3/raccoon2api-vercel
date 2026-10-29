'use strict';
// 零依赖 HTTP 助手：用 Node 原生 https/http 发请求（跟 APK 的 HttpURLConnection 对应）
// 支持从完整 base URL 解析 host/路径，自动处理 JSON、超时、错误
const http = require('http');
const https = require('https');
const tls = require('tls');

// 从 "https://host:port/path/..." 拆出 {host, port, path, isHttps}
function parseBase(base) {
  const m = /^(https?:)\/\/([^/]+)(\/.*)?$/.exec(base);
  if (!m) throw new Error('bad_base: ' + base);
  const proto = m[1];
  const hostport = m[2];
  const basePath = (m[3] || '').replace(/\/$/, '');
  let host = hostport, port = '';
  const ci = hostport.lastIndexOf(':');
  if (ci > 0 && !hostport.includes(']')) {
    host = hostport.slice(0, ci);
    port = hostport.slice(ci + 1);
  }
  return { isHttps: proto === 'https:', host, port: port || (proto === 'https:' ? 443 : 80), basePath };
}

// 发起请求。opt: {base, path, method, headers, body(obj->json string), timeoutMs, raw(false=解析json)}
// 返回 {status, headers, data(json对象|null), rawBody}
function request(opt) {
  const { isHttps, host, port, basePath } = parseBase(opt.base);
  const finalPath = basePath + (opt.path || '');
  const method = opt.method || 'GET';
  const headers = Object.assign({}, opt.headers || {});
  let bodyBuf = null;
  if (opt.body !== undefined && opt.body !== null) {
    const s = typeof opt.body === 'string' ? opt.body : JSON.stringify(opt.body);
    bodyBuf = Buffer.from(s, 'utf8');
    if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = bodyBuf.length;
  }
  const mod = isHttps ? https : http;
  return new Promise((resolve, reject) => {
    const url = (isHttps ? 'https' : 'http') + '://' + host + (port ? ':' + port : '') + finalPath;
    const reqOpt = {
      method,
      host,
      port: Number(port) || 443,
      path: finalPath,
      headers,
    };
    // 关闭 TLS 校验（小浣熊证书可能不被默认信任）——可开关
    if (opt.insecure && isHttps) {
      reqOpt.rejectUnauthorized = false;
    }
    const req = mod.request(reqOpt, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = JSON.parse(rawBody); } catch (e) { data = null; }
        resolve({ status: res.statusCode, headers: res.headers, data, rawBody });
      });
    });
    // 总时长超时（不是空闲超时）：到点无条件断开，避免上游慢速输出把空闲计时刷掉
    const _ttlMs = opt.timeoutMs || 30000;
    const _ttlTimer = setTimeout(() => {
      try { req.destroy(new Error('timeout')); } catch (_) {}
    }, _ttlMs);
    if (_ttlTimer.unref) _ttlTimer.unref();
    req.on('close', () => { clearTimeout(_ttlTimer); });
    req.on('error', (e) => reject(e));
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

module.exports = { request, requestStream, parseBase };


// 流式请求：不解析响应体，直接返回 {status, headers, res, base, finalPath}
// 供 SSE/大响应透传使用（调用方负责 res.pipe / 读取 + 关闭）
function requestStream(opt) {
  const { isHttps, host, port, basePath } = parseBase(opt.base);
  const finalPath = basePath + (opt.path || '');
  const method = opt.method || 'GET';
  const headers = Object.assign({}, opt.headers || {});
  let bodyBuf = null;
  if (opt.body !== undefined && opt.body !== null) {
    const b = typeof opt.body === 'string' ? opt.body : JSON.stringify(opt.body);
    bodyBuf = Buffer.from(b, 'utf8');
    if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = bodyBuf.length;
  }
  const mod = isHttps ? https : http;
  return new Promise((resolve, reject) => {
    const reqOpt = {
      method, host, port: Number(port) || (isHttps ? 443 : 80),
      path: finalPath, headers,
    };
    if (opt.insecure && isHttps) reqOpt.rejectUnauthorized = false;
    const req = mod.request(reqOpt, (res) => {
      resolve({ status: res.statusCode, headers: res.headers, res, base: opt.base, finalPath });
    });
    // 总时长超时：到点无条件断开（空闲超时会被慢速数据刷掉，不可靠）
    const _stTtlMs = opt.timeoutMs || 30000;
    const _stTimer = setTimeout(() => {
      try { req.destroy(new Error('timeout')); } catch (_) {}
    }, _stTtlMs);
    if (_stTimer.unref) _stTimer.unref();
    req.on('close', () => { clearTimeout(_stTimer); });
    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

