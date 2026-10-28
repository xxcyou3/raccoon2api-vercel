// 扫码自助登录（官方微信扫码，Vercel 后端直调，无需跳转）
// 实测接口（HTTP 200 已确认）：
//   POST https://xiaohuanxiong.com/api/iam/v1/auth/mp/qrcode  空body → {data:{qrcode_code, scan_path:"/login/mp", expires_in, poll_interval}}
//   POST /auth/mp/qrcode/login  {qrcode_code} → {data:{status:pending/logging/success/canceled, access_token?}}
// 微信扫码 → status=success 拿到 access_token → 换票存账号
const https = require('https');
const util = require('./util');
const accounts = require('./accounts');

const IAM_BASE = process.env.RACCOON_IAM_BASE || 'https://xiaohuanxiong.com/api/iam/v1';
const ORIGIN = process.env.RACCOON_MAIN_ORIGIN || 'https://xiaohuanxiong.com';

function rawJson(url, method, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      host: u.host, path: u.pathname + u.search, method: method || 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': ORIGIN,
        'Referer': ORIGIN + '/',
        'User-Agent': 'Mozilla/5.0 (Linux; Android 14; Redmi K50) AppleWebKit/537.36',
      },
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        const headers = res.headers || {};
        try { resolve({ status: res.statusCode, json: JSON.parse(d), headers }); }
        catch (e) { resolve({ status: res.statusCode, json: null, raw: d, headers }); }
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

// 生成官方微信扫码（返回二维码内容 + 轮询参数）
async function createQrcode() {
  const r = await rawJson(`${IAM_BASE}/auth/mp/qrcode`, 'POST', {});
  const d = r.json && r.json.data;
  if (!d || !d.qrcode_code) throw new Error('createQrcode 失败: ' + JSON.stringify(r.json || r.raw));
  // 二维码内容 = 官网补全的扫码地址
  const qrContent = `${ORIGIN}${d.scan_path}?qrcode_code=${d.qrcode_code}`;
  return { qrcode_code: d.qrcode_code, qrContent, expires_in: d.expires_in, poll_interval: d.poll_interval || 2 };
}

// 轮询扫码状态；success 时返回 access_token
async function pollQrcode(qrcode_code) {
  const r = await rawJson(`${IAM_BASE}/auth/mp/qrcode/login`, 'POST', { qrcode_code });
  const d = r.json && r.json.data;
  if (!d || !d.status) throw new Error('pollQrcode 失败: ' + JSON.stringify(r.json || r.raw));
  // refresh_token 不在 body，而是随 Set-Cookie 下发（官网前端从 cookie raccoon_refresh_token 读取）。
  // cookie 名形如 raccoon_refresh_token 或 <前缀>_raccoon_refresh_token，取最后一个匹配项。
  let refreshToken = '';
  try {
    const rawSetCookie = (r.headers && (r.headers['set-cookie'] || r.headers['Set-Cookie'])) || [];
    const list = Array.isArray(rawSetCookie) ? rawSetCookie : [String(rawSetCookie)];
    for (const line of list) {
      const m = /(?:^|[;,\s])([A-Za-z0-9_-]*raccoon_refresh_token)=([^;]*)/.exec(String(line));
      if (m && m[2]) refreshToken = decodeURIComponent(m[2]);
    }
  } catch (_) {}
  return { status: d.status, access_token: d.access_token, refresh_token: refreshToken };
}

// 把扫码登录拿到的 access_token 存成账号
async function saveMpAccount(accessToken, refreshToken) {
  // accessToken 通常是 JWT，从 payload 解出 UserID/name
  let uid = 'mp-' + util.randomToken(8), name = '扫码账号';
  try {
    const parts = accessToken.split('.');
    if (parts[1]) {
      const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      uid = p.user_id || p.userId || p.sub || uid;
      name = p.name || p.nickname || name;
    }
  } catch (_) {}
  const acct = { UserID: uid, name, accessToken, refreshToken: refreshToken || '', expiryMs: 0, updatedAt: Date.now() };
  await accounts.saveAccount(acct);
  return acct;
}

// GET /api/qrcode —— 前端拉取二维码（生成后存内存，供轮询校对）
let lastQr = null;
async function qrcodeApi(ctx) {
  try {
    const qr = await createQrcode();
    lastQr = qr;
    return util.json(ctx.res, 200, { success: true, qr });
  } catch (e) {
    return util.json(ctx.res, 502, { success: false, error: e.message });
  }
}

// GET /api/qrcode-poll?code=<qrcode_code> —— 前端轮询扫码状态
async function pollApi(ctx) {
  try {
    const code = (ctx.query && (ctx.query.code || ctx.query.qrcode_code)) || '';
    if (!code) return util.json(ctx.res, 400, { success: false, error: 'missing code' });
    const r = await pollQrcode(code);
    // 防止拿的是别人刚生成的码，只认最近一次
    if (lastQr && lastQr.qrcode_code !== code) return util.json(ctx.res, 200, { success: true, status: 'pending' });
    if (r.status === 'success' && r.access_token) {
      const acct = await saveMpAccount(r.access_token, r.refresh_token);
      return util.json(ctx.res, 200, { success: true, status: 'success', account: { UserID: acct.UserID, name: acct.name } });
    }
    return util.json(ctx.res, 200, { success: true, status: r.status });
  } catch (e) {
    return util.json(ctx.res, 502, { success: false, error: e.message });
  }
}

// GET /login —— 扫码自助登录页
function page(ctx) {
  const t = new Date().toISOString().replace(/[:.]/g, '-');
  const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>小浣熊网关 · 扫码登录</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0a0a12;color:#e6e3da;font-family:-apple-system,'PingFang SC',sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{background:#151523;border:1px solid #242439;border-radius:16px;padding:30px;max-width:380px;width:100%;text-align:center}
h1{font-size:19px;margin-bottom:5px;letter-spacing:1px}
.sub{color:#6d6a80;font-size:12px;margin-bottom:20px}
#qrbox{width:220px;height:220px;margin:0 auto 18px;border:1px solid #242439;border-radius:12px;display:flex;align-items:center;justify-content:center;overflow:hidden;background:#fff}
#qrbox canvas,#qrbox img{max-width:100%;max-height:100%}
#status{font-size:13px;color:#8b8ba0;min-height:20px;margin-bottom:14px}
.btns button, .re-btn{border:none;border-radius:8px;padding:11px 18px;font-size:14px;cursor:pointer;margin:0 5px}
.primary{background:linear-gradient(135deg,#d4af37,#b8860b);color:#1a1507;font-weight:700}
.ghost{background:#242439;color:#c9c6d8}
.ok{color:#5fc98a;font-weight:700}
.fail{color:#e06a6a;font-weight:700}
.tip{color:#6d6a80;font-size:11px;margin-top:16px;line-height:1.7}
</style></head><body>
<div class="card">
<h1>小浣熊 · 扫码登录</h1>
<div class="sub">微信扫码授权，扫码成功后自动换票并写入账号</div>
<div id="qrbox"><div id="qrhint" style="color:#666;font-size:13px">正在生成二维码…</div></div>
<div id="status"></div>
<div class="btns"><button class="primary" onclick="loadQr()">重新生成</button></div>
<div class="tip">用微信扫一扫上方二维码 → 手机确认授权 → 浏览器自动完成登录并提示成功。<br>${t}</div>
</div>
<script>
// 极简二维码生成（无依赖）
function makeQr(text, cb){ var s=document.createElement('script'); window.__qrCB=cb; window.__qrText=text;
  // 内联一个最小 QR 编码器（本函数由后端注入，见下方 __QR_IMPL__）
  if(window.__QR) { window.__QR(text, function(canvas){cb(canvas);}); }
  else cb(null);
}
var code='', timer=null;
function loadQr(){ document.getElementById('qrhint').textContent='正在生成二维码…';
  var st=document.getElementById('status'); st.textContent=''; st.className='';
  fetch('/api/qrcode').then(r=>r.json()).then(j=>{
    if(!j.success){ st.textContent='生成失败: '+(j.error||''); st.className='fail'; return; }
    code=j.qr.qrcode_code;
    // 用二维码库画（后端注入实现）
    makeQr(j.qr.qrContent, function(cv){ var b=document.getElementById('qrbox');
      b.innerHTML=''; if(cv){ if(cv.toDataURL){cv.style.width='210px';cv.style.height='210px';b.appendChild(cv);} else b.appendChild(cv); }
      else b.innerHTML='<img src="https://api.qrserver.com/v1/create-qr-code/?size=210x210&data='+encodeURIComponent(j.qr.qrContent)+'">';
    });
    startPoll();
  }).catch(e=>{ var st=document.getElementById('status'); st.textContent='生成失败'; st.className='fail'; });
}
function startPoll(){ clearInterval(timer); var iv=(lastIv||2);
  timer=setInterval(function(){ if(!code) return;
    fetch('/api/qrcode-poll?code='+encodeURIComponent(code)).then(r=>r.json()).then(j=>{
      var st=document.getElementById('status');
      if(j.success && j.status==='success'){ st.textContent='✔ 登录成功，账号已添加('+(j.account?j.account.name:'')+')，正在跳转…'; st.className='ok'; clearInterval(timer);
        var acc=(j.account&&j.account.UserID)||''; var tk='';
        try{ tk=localStorage.getItem('r2a_tok')||''; }catch(e){}
        var qq=[]; if(tk)qq.push('token='+encodeURIComponent(tk)); if(acc)qq.push('uid='+encodeURIComponent(acc));
        setTimeout(function(){ location.href='/admin'+(qq.length?('?'+qq.join('&')):''); }, 1200); }
      else if(j.status==='pending'||j.status==='logging'){ st.textContent='等待扫码…'; st.className=''; }
      else if(j.status==='canceled'){ st.textContent='已取消，请重新扫码'; st.className='fail'; clearInterval(timer); }
      else if(!j.success){ st.textContent='轮询错误: '+(j.error||''); }
    }).catch(()=>{});
  }, (iv||2)*1000);
}
var lastIv=2, iv={};
loadQr();
</script></body></html>`;
  return util.html(ctx.res, 200, html);
}

module.exports = { page, qrcodeApi, pollApi, createQrcode, pollQrcode, saveMpAccount };
