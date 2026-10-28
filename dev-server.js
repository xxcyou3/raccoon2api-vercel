'use strict';
// 本地开发服务器：复用 api/index.js 的 Vercel handler，起一个裸 HTTP 服务
// 用作本地 curl 实测各路由（/login /v1/models /health /admin 等）
// 用法：node dev-server.js [port]  默认 3000
const http = require('http');
const handler = require('./api/index.js');

const port = Number(process.env.PORT || process.argv[2] || 3000);

const server = http.createServer((req, res) => {
  res.on('finish', () => {
    console.log(`[${req.method}] ${req.url} -> ${res.statusCode}`);
  });
  handler(req, res).catch((e) => {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'dev_server_error', message: String(e && e.message) }));
    } else {
      try { res.end(); } catch (_) {}
    }
  });
});

server.listen(port, () => {
  console.log('raccoon2api-vercel dev server at http://localhost:' + port);
  console.log('  /health       健康检查');
  console.log('  /login        扫码登录页');
  console.log('  /submit-code  手动贴 code 换票');
  console.log('  /admin        管理面板');
  console.log('  /v1/models    模型目录');
  console.log('  /v1/chat/completions  OpenAI 兼容网关(需账号)');
});
