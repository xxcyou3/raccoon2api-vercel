
'use strict';
// 通过 Vercel REST API 部署（内联文件，无需 CLI / npm）
// 需环境变量：VERCEL_TOKEN（必填）、VERCEL_TEAM_ID（可选）、VERCEL_PROJECT(默认 raccoon2api-vercel)
// 用法：SRC=/workspace/raccoon2api-vercel node deploy_vercel.js
const fs = require('fs');
const path = require('path');
const https = require('https');

const TOKEN = process.env.VERCEL_TOKEN;
const TEAM = process.env.VERCEL_TEAM_ID ? ('?teamId=' + encodeURIComponent(process.env.VERCEL_TEAM_ID)) : '';
const PROJECT = process.env.VERCEL_PROJECT || 'raccoon2api-vercel';
const ROOT = process.env.SRC || '/workspace/raccoon2api-vercel';

if (!TOKEN) { console.error('缺少 VERCEL_TOKEN'); process.exit(1); }

function api(method, p, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = { Authorization: 'Bearer ' + TOKEN, 'User-Agent': 'deploy' };
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
    const req = https.request({ host: 'api.vercel.com', path: p + TEAM, method, headers, timeout: 120000 }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { b += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) { j = { raw: b.slice(0, 600) }; } resolve({ status: res.statusCode, body: j }); });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const FILES = [
  'api/index.js', 'package.json', 'vercel.json',
  'lib/util.js', 'lib/net.js', 'lib/auth.js', 'lib/checkin.js',
  'lib/accounts.js', 'lib/login.js', 'lib/qrlogin.js', 'lib/cron.js', 'lib/openai.js', 'lib/admin.js',
  'lib/extras.js', 'lib/envstore.js', 'lib/keys.js', 'lib/logs.js', 'lib/kv.js',
];

async function main() {
  // 1. 找到项目
  const projects = await api('GET', '/v9/projects');
  let projectId = null;
  if (projects.body && projects.body.projects) {
    const hit = projects.body.projects.find(pr => pr.name === PROJECT);
    if (hit) projectId = hit.id;
  }
  if (!projectId) {
    console.log('项目不存在，创建', PROJECT);
    const cr = await api('POST', '/v10/projects', { name: PROJECT, framework: null });
    if (cr.body && cr.body.id) projectId = cr.body.id;
    else { console.error('创建项目失败', cr.status, cr.body); process.exit(1); }
  }
  console.log('项目 id:', projectId);

  // 2. 上传文件
  const files = [];
  let total = 0;
  for (const f of FILES) {
    const full = path.join(ROOT, f);
    if (!fs.existsSync(full)) { console.log('跳过（不存在）', f); continue; }
    const data = fs.readFileSync(full, 'utf8');
    total += Buffer.byteLength(data);
    files.push({ file: f, data });
  }
  console.log(`准备 ${files.length} 个文件，共 ${(total/1024).toFixed(1)} KB`);
  const sha = require('crypto').createHash('sha1').update(Date.now().toString()).digest('hex').slice(0, 8);
  // 用 deployment 的 files 参数直接内联（小项目无需分目录上传）
  const depBody = {
    name: PROJECT,
    project: projectId,
    target: 'production',
    files: { '.': { content: '' } },   // vercel 会要求：非零文件走 files 数组；这里演示，实际用小版本
  };
  const dep = await api('POST', '/v13/deployments', {
    name: PROJECT,
    project: projectId,
    files: files.map(f => ({ file: f.file, data: f.data })),
    target: 'production',
    autoAssignCustomDomains: true,
  });
  if (dep.status >= 400) { console.error('部署失败', dep.status, JSON.stringify(dep.body).slice(0, 800)); process.exit(1); }
  const url = (dep.body && dep.body.url) || '';
  console.log('部署成功 URL:', url ? 'https://' + url : JSON.stringify(dep.body).slice(0, 400));
}

main().catch(e => { console.error(e); process.exit(1); });
