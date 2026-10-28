// Web 管理控制台（高级极客风：顶部一级导航 + 多区卡片流 Dashboard，移动端自适应）
// route(ctx): /admin 面板（SPA：登录页/仪表盘/账号管理/数据查看）
// api(ctx):   /api/admin/accounts | /api/admin/balance?account= | POST /api/admin/checkin | DELETE /api/admin/account
// 鉴权：RACCOON_ADMIN_TOKEN（未配置则允许访问）
const accounts = require('./accounts');
const auth = require('./auth');
const util = require('./util');
const checkin = require('./checkin');

const ADMIN_TOKEN = process.env.RACCOON_ADMIN_TOKEN || '';
const CY = '#00e5ff', GOLD = '#ffd54a';

function authed(ctx) {
  if (!ADMIN_TOKEN) return true;
  const h = ctx.headers || {};
  const bearer = String(h['authorization'] || h['Authorization'] || '').replace(/^Bearer\s+/i, '').trim();
  const xtok = String(h['x-admin-token'] || '').trim();
  const qtok = (ctx.query && ctx.query.token) ? String(ctx.query.token) : '';
  return bearer === ADMIN_TOKEN || xtok === ADMIN_TOKEN || qtok === ADMIN_TOKEN;
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function escAttr(s) { return esc(s).replace(/"/g, '&quot;'); }

const UI_BASE = `
:root{
  --bg:#1a1a19; --bg-1:#1e1e1d; --bg-2:#232322; --bg-3:#2a2a28; --bg-inset:#161615;
  --line:#302f2d; --line-2:#282826; --line-3:#3a3937;
  --ink:#ded9d1; --ink-2:#a8a29a; --ink-3:#7b756d; --ink-4:#5d5852;
  --gold:#b9a173; --gold-1:#cdb98f; --gold-2:#9a845e;
  --gold-a:rgba(185,161,115,.10); --gold-b:rgba(185,161,115,.22);
  --violet:#948cb5; --violet-a:rgba(148,140,181,.12);
  --ok:#7fa98b; --ok-a:rgba(127,169,139,.12);
  --warn:#c0a273; --err:#bb8585; --err-a:rgba(187,133,133,.12);
  --r-sm:8px; --r-md:10px; --r-lg:14px;
  --ff:-apple-system,BlinkMacSystemFont,"PingFang SC","Noto Sans SC","Microsoft YaHei",system-ui,sans-serif;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
*,*::before,*::after{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--ff);font-size:14px;line-height:1.65;-webkit-font-smoothing:antialiased}
a{color:var(--gold-1);text-decoration:none}
.wrap{max-width:1120px;margin:0 auto;padding:0 18px 72px}
.topbar{position:sticky;top:0;z-index:20;background:rgba(26,26,25,.88);backdrop-filter:blur(12px);border-bottom:1px solid var(--line-2)}
.topbar-in{max-width:1120px;margin:0 auto;padding:11px 18px;display:flex;align-items:center;gap:14px}
.brand{display:flex;align-items:center;gap:9px;font-size:14.5px;letter-spacing:.05em;white-space:nowrap}
.brand .dot{width:7px;height:7px;border-radius:50%;background:var(--gold);box-shadow:0 0 10px var(--gold-b)}
.brand small{color:var(--ink-4);font-size:10.5px;letter-spacing:.14em}
.nav{display:flex;gap:2px;margin-left:auto;overflow-x:auto;scrollbar-width:none}
.nav::-webkit-scrollbar{display:none}
.nav button{white-space:nowrap;border:none;background:transparent;color:var(--ink-2);font-family:inherit;font-size:13px;padding:7px 11px;border-radius:var(--r-sm);cursor:pointer;transition:.16s}
.nav button:hover{color:var(--ink);background:var(--bg-2)}
.nav button.on{color:var(--gold-1);background:var(--gold-a);box-shadow:inset 0 0 0 1px var(--gold-b)}
.page{display:none}
.page.on{display:block}
.page-head{padding:32px 0 20px;display:flex;align-items:flex-end;gap:14px;flex-wrap:wrap}
.page-head h1{margin:0;font-size:20px;font-weight:600}
.page-head p{margin:0;color:var(--ink-3);font-size:12.5px}
.card{background:var(--bg-1);border:1px solid var(--line-2);border-radius:var(--r-lg);padding:18px 20px}
.card+.card{margin-top:14px}
.card h3{margin:0 0 14px;font-size:12.5px;font-weight:600;color:var(--ink-2);letter-spacing:.07em}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(168px,1fr))}
.kpi{background:var(--bg-1);border:1px solid var(--line-2);border-radius:var(--r-lg);padding:15px 17px}
.kpi .k{font-size:11.5px;color:var(--ink-3);letter-spacing:.07em}
.kpi .v{font-size:26px;font-weight:600;margin-top:5px;font-variant-numeric:tabular-nums}
.kpi .v.gold{color:var(--gold-1)}
.tbl-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;font-weight:500;color:var(--ink-3);font-size:11.5px;letter-spacing:.07em;padding:0 10px 10px;border-bottom:1px solid var(--line-2);white-space:nowrap}
td{padding:11px 10px;border-bottom:1px solid var(--line-2);vertical-align:middle}
tr:last-child td{border-bottom:none}
.name{color:var(--ink);font-weight:500}
.uid{color:var(--ink-4);font-family:var(--mono);font-size:11px;margin-top:2px;word-break:break-all}
.pts{font-variant-numeric:tabular-nums;color:var(--gold-1);font-weight:600}
.pill{display:inline-block;padding:2px 8px;border-radius:20px;font-size:11px;white-space:nowrap}
.pill.ok{color:var(--ok);background:var(--ok-a)}
.pill.wait{color:var(--warn);background:rgba(192,162,115,.12)}
.pill.exp{color:var(--err);background:var(--err-a)}
.muted{color:var(--ink-4)}
.btn{border:1px solid var(--line-3);background:var(--bg-2);color:var(--ink-2);font-family:inherit;font-size:12.5px;padding:7px 13px;border-radius:var(--r-sm);cursor:pointer;transition:.16s}
.btn:hover{color:var(--ink);border-color:var(--gold-2)}
.btn.gold{color:#1a1a19;background:var(--gold);border-color:var(--gold);font-weight:600}
.btn.gold:hover{background:var(--gold-1)}
.btn.sm{padding:4px 9px;font-size:11.5px}
.btn.link{border:none;background:transparent;color:var(--ink-3);padding:4px 6px}
.btn.link:hover{color:var(--gold-1);background:transparent}
.field{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
input,textarea,select{background:var(--bg-inset);border:1px solid var(--line);color:var(--ink);font-family:inherit;font-size:13px;padding:8px 11px;border-radius:var(--r-sm);outline:none;transition:.16s}
input:focus,textarea:focus,select:focus{border-color:var(--gold-2);background:var(--bg)}
textarea{width:100%;min-height:88px;resize:vertical;line-height:1.6}
pre{background:var(--bg-inset);border:1px solid var(--line-2);border-radius:var(--r-md);padding:12px 14px;font-family:var(--mono);font-size:12px;color:var(--ink-2);overflow:auto;max-height:340px;white-space:pre-wrap;word-break:break-all;margin:0}
.login-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.login-box{width:100%;max-width:340px;background:var(--bg-1);border:1px solid var(--line-2);border-radius:18px;padding:32px 26px}
.login-box .lg{width:38px;height:38px;border-radius:12px;background:var(--gold-a);box-shadow:inset 0 0 0 1px var(--gold-b);display:flex;align-items:center;justify-content:center;font-size:18px;margin-bottom:18px}
.login-box h1{margin:0 0 4px;font-size:17px;font-weight:600;letter-spacing:.02em}
.login-box .sub{color:var(--ink-4);font-size:11.5px;letter-spacing:.1em;margin-bottom:24px}
.login-box label{display:block;font-size:11.5px;color:var(--ink-3);letter-spacing:.08em;margin-bottom:7px}
.login-box input{width:100%;margin-bottom:14px}
.login-box .btn{width:100%;padding:10px;font-size:13px}
.login-box .err{color:var(--err);font-size:12px;margin-top:10px;min-height:16px;text-align:center}
.dock{display:none}
@media(max-width:720px){
  .mGrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px}
  .mCard{border:1px solid var(--line-2);border-radius:10px;padding:10px 12px;background:var(--bg-2)}
  .mName{font-weight:600;color:var(--ink);font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .mId{color:var(--ink-3);font-size:11px;margin-top:3px;font-family:ui-monospace,Menlo,monospace;word-break:break-all}
  .mMeta{font-size:11px;color:var(--ink-4);margin-top:6px}
  .topbar-in{padding:9px 13px;gap:8px}
  .brand small{display:none}
  .brand{font-size:13.5px;letter-spacing:0;white-space:nowrap}
  /* 底部 dock 改为横向滚动，按钮保持自身宽度，中文不再被挤成一字一行 */
  .nav{position:fixed;left:0;right:0;bottom:0;margin:0;gap:2px;background:rgba(30,30,29,.97);border-top:1px solid var(--line-2);padding:5px 6px calc(5px + env(safe-area-inset-bottom));justify-content:flex-start;overflow-x:auto;overflow-y:hidden;-webkit-overflow-scrolling:touch;scrollbar-width:none;z-index:30}
  .nav::-webkit-scrollbar{display:none}
  .nav button{flex:0 0 auto;min-width:0;padding:7px 10px;font-size:11.5px;white-space:nowrap;letter-spacing:0}
  .wrap{padding:0 12px 86px}
  .page-head{padding:18px 0 12px;gap:6px}
  .page-head h1{font-size:17px;white-space:nowrap}
  .page-head p{font-size:11.5px}
  .kpi .v{font-size:21px}
  .kpi{padding:12px 13px}
  .grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}
  .card{padding:13px 11px;border-radius:12px}
  .card h3{font-size:11.5px;letter-spacing:.03em;white-space:nowrap}
  /* 表格不压缩列宽，改为横向滚动，避免中文被挤成竖排 */
  .tbl-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;margin:0 -4px;padding:0 4px}
  table{font-size:12.5px;min-width:620px;table-layout:auto}
  th,td{padding:10px 8px;white-space:nowrap}
  td .name,td .uid{white-space:nowrap;word-break:normal;overflow:hidden;text-overflow:ellipsis;max-width:130px}
  /* 窄屏下所有输入框不允许 min-width 硬撑，也不允许把字挤成竖排 */
  input,select,textarea{min-width:0!important;max-width:100%}
  .field{gap:7px}
  .field input,.field select,.field textarea{flex:1 1 100%;width:100%}
  .field .btn{flex:0 0 auto;white-space:nowrap}
  .btn{white-space:nowrap}
  input,select{font-size:16px}
  pre{font-size:11.5px;padding:10px 11px;white-space:pre-wrap;word-break:break-word}
  .login-wrap{padding:16px}
  .login-box{padding:26px 20px}
  .login-box h1{font-size:16px}
}
@media(max-width:400px){
  .nav button{font-size:11px;padding:7px 9px}
  .grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
  .kpi .v{font-size:19px}
  table{min-width:580px}
}
`;
function renderLogin() {
  return '<!doctype html><html lang="zh"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>小浣熊网关 · 控制台</title><style>' + UI_BASE + '</style></head><body>'
    + '<div class="login-wrap"><div class="login-box">'
    + '<div class="lg">&#129437;</div>'
    + '<h1>小浣熊网关</h1><div class="sub">RACCOON2API CONSOLE</div>'
    + '<label for="tk">访问口令</label>'
    + '<input id="tk" type="password" placeholder="请输入后台口令" autocomplete="current-password">'
    + '<button class="btn gold" id="go">进入控制台</button>'
    + '<div class="err" id="err"></div>'
    + '</div></div>'
    + '<script>'
    + 'function submit(){var t=(document.getElementById("tk").value||"").trim();'
    + 'if(!t){document.getElementById("err").textContent="请输入口令";return;}'
    + 'try{localStorage.setItem("r2a_tok",t);}catch(e){}'
    + 'location.href="/admin?token="+encodeURIComponent(t);}'
    + 'document.getElementById("go").onclick=submit;'
    + 'document.getElementById("tk").addEventListener("keydown",function(e){if(e.key==="Enter")submit();});'
    + 'document.getElementById("tk").focus();'
  + 'try{var _t=localStorage.getItem("r2a_tok")||"";if(_t&&!/[?&]token=/.test(location.search)&&!/[?&]t=1/.test(location.search)){location.replace("/admin?token="+encodeURIComponent(_t)+"&t=1");}}catch(e){}'
    + '</script></body></html>';
}

function renderPanel(rows) {
  const total = rows.length;
  const checkedToday = rows.filter(r => r.today === 'Y').length;
  const expired = rows.filter(r => r.expired).length;
  const rate = total ? Math.round(checkedToday / total * 100) : 0;

  const emptyRow = '<tr><td colspan="6" class="muted" style="padding:18px 10px">暂无账号，去「账号管理」扫码或粘贴 refresh_token 接入</td></tr>';

  const rowHtml = (r) => {
    const name = esc(r.name || r.UserID || '未命名');
    const uid = esc(r.UserID || '');
    const pts = (r.points === null || r.points === undefined) ? '—' : esc(r.points);
    const exp = r.expired ? '<span class="pill exp">已过期</span>' : '<span class="pill ok">正常</span>';
    const today = r.today === 'Y' ? '<span class="pill ok">已签</span>' : '<span class="pill wait">待签</span>';
    const expTime = r.expiryMs ? new Date(Number(r.expiryMs)).toLocaleString('zh-CN', { hour12: false }) : '—';
    return '<tr>'
      + '<td><div class="name">' + name + '</div><div class="uid">' + uid + '</div></td>'
      + '<td class="pts">' + pts + '</td>'
      + '<td class="muted">' + esc(expTime) + '</td>'
      + '<td>' + today + '</td>'
      + '<td>' + exp + '</td>'
      + '<td style="white-space:nowrap">'
      + '<button class="btn sm" data-act="ci" data-uid="' + uid + '">签到</button> '
      + '<button class="btn sm link" data-act="bills" data-uid="' + uid + '">明细</button>'
      + '<button class="btn sm link" data-act="del" data-uid="' + uid + '">删除</button>'
      + '</td></tr>';
  };
  const rowsHtml = total ? rows.map(rowHtml).join('') : emptyRow;

  return '<!doctype html><html lang="zh"><head><meta charset="utf-8">'
  + '<meta name="viewport" content="width=device-width,initial-scale=1">'
  + '<title>小浣熊网关 · 控制台</title><style>' + UI_BASE + '</style></head><body>'

  + '<div class="topbar"><div class="topbar-in">'
  + '<div class="brand"><span class="dot"></span>小浣熊网关 <small>RACCOON2API</small></div>'
  + '<div class="nav">'
  + '<button class="on" data-page="dashboard">仪表盘</button>'
  + '<button data-page="accounts">账号管理</button>'
  + '<button data-page="data">数据查看</button>'
  + '<button data-page="settings">设置</button>'
  + '<button data-page="keys">Key</button>'
  + '<button data-page="debug">调试</button>'
  + '<button data-page="logs">日志</button>'
  + '</div></div></div>'

  + '<div class="wrap">'

  // ---- 仪表盘 ----
  + '<div class="page on" id="pg-dashboard">'
  + '<div class="page-head"><h1>仪表盘</h1><p>账号、积分与签到状态总览</p></div>'
  + '<div class="grid">'
  + '<div class="kpi"><div class="k">总积分</div><div class="v gold" id="kpiPts">—</div></div>'
  + '<div class="kpi"><div class="k">账号数</div><div class="v" id="kpiAcc">' + total + '</div></div>'
  + '<div class="kpi"><div class="k">今日已签</div><div class="v" id="kpiChk">' + checkedToday + '</div></div>'
  + '<div class="kpi"><div class="k">签到率</div><div class="v" id="kpiRate">' + rate + '%</div></div>'
  + '</div>'
  + '<div class="card" style="margin-top:14px"><h3>账号概览</h3>'
  + '<div class="tbl-scroll"><table><thead><tr>'
  + '<th>账号</th><th>积分</th><th>过期时间</th><th>今日</th><th>状态</th><th>操作</th>'
  + '</tr></thead><tbody id="tbDash">' + rowsHtml + '</tbody></table></div></div>'
  + '</div>'

  // ---- 账号管理 ----
  + '<div class="page" id="pg-accounts">'
  + '<div class="page-head"><h1>账号管理</h1><p>积分直接显示，无需逐个点开</p></div>'
  + '<div class="card"><h3>接入新账号</h3>'
  + '<div class="field">'
  + '<input id="rtIn" placeholder="粘贴 refresh_token 直接换账号" style="flex:1;min-width:200px">'
  + '<button class="btn gold" data-act="addrt">换账号</button>'
  + '<a class="btn" href="/login" target="_blank">微信扫码</a>'
  + '</div>'
  + '<div class="muted" style="font-size:12px;margin-top:10px">refresh_token 一次性轮换，换到新票会自动保存；扫码账号首次调业务接口会自动完成 IAM 确认。</div>'
  + '</div>'
  + '<div class="card"><h3>账号列表 · <span id="accSum" class="pts">—</span></h3>'
  + '<div class="tbl-scroll"><table><thead><tr>'
  + '<th>账号</th><th>积分</th><th>过期时间</th><th>今日</th><th>状态</th><th>操作</th>'
  + '</tr></thead><tbody id="tbAcc">' + rowsHtml + '</tbody></table></div></div>'
  + '</div>'

  // ---- 数据查看 ----
  + '<div class="page" id="pg-data">'
  + '<div class="page-head"><h1>数据查看</h1><p>各账号积分与最近账单明细</p></div>'
  + '<div class="card"><h3>积分汇总</h3>'
  + '<div class="tbl-scroll"><table><thead><tr>'
  + '<th>账号</th><th>积分</th><th>过期时间</th><th>今日</th><th>状态</th><th>操作</th>'
  + '</tr></thead><tbody id="tbData">' + rowsHtml + '</tbody></table></div></div>'
  + '<div class="card"><h3>账单明细</h3><div id="billsBox" class="muted" style="font-size:12.5px">点击上方「明细」查看某个账号的账单</div></div>'
  + '</div>'

  // ---- 设置 ----
  + '<div class="page" id="pg-settings">'
  + '<div class="page-head"><h1>设置</h1><p>变量保存后自动同步到 Vercel 环境变量</p></div>'
  + '<div class="card"><h3>环境变量</h3>'
  + '<div class="tbl-scroll"><table><thead><tr><th>变量名</th><th>值</th><th>操作</th></tr></thead>'
  + '<tbody id="setBody"><tr><td colspan="3" class="muted">读取中…</td></tr></tbody></table></div></div>'
  + '</div>'

  // ---- Key ----
  + '<div class="page" id="pg-keys">'
  + '<div class="page-head"><h1>API Key</h1><p>新建或删除会自动同步到 Vercel</p></div>'
  + '<div class="card"><h3>新建 Key</h3>'
  + '<div class="field"><input id="keyName" placeholder="备注名，例如 我的客户端" style="flex:1;min-width:180px">'
  + '<button class="btn gold" data-act="addkey">新建</button></div>'
  + '</div>'
  + '<div class="card"><h3>已创建</h3>'
  + '<div class="tbl-scroll"><table><thead><tr><th>名称</th><th>Key</th><th>操作</th></tr></thead>'
  + '<tbody id="keyBody"><tr><td colspan="3" class="muted">读取中…</td></tr></tbody></table></div></div>'
  + '</div>'

  // ---- 调试 ----
  + '<div class="page" id="pg-debug">'
  + '<div class="page-head"><h1>模型调试</h1><p>经 OpenAI 兼容网关真实调用一次（非流式）</p></div>'
  + '<div class="card"><h3>请求</h3>'
  + '<div class="field" style="margin-bottom:10px"><select id="dbgModel" style="min-width:180px"></select>'
  + '<input id="dbgPrompt" placeholder="输入一句话" style="flex:1;min-width:180px">'
  + '<button class="btn gold" data-act="dbg">发送</button></div>'
  + '<textarea id="dbgTools" placeholder="可选：工具定义 JSON（数组），例如 [{&quot;type&quot;:&quot;function&quot;,&quot;function&quot;:{&quot;name&quot;:&quot;get_time&quot;,&quot;parameters&quot;:{&quot;type&quot;:&quot;object&quot;,&quot;properties&quot;:{}}}}]"></textarea>'
  + '</div>'
  + '<div class="card"><h3>返回</h3><pre id="dbgOut">（尚未请求）</pre></div>'
  + '</div>'

  // ---- 日志 ----
  + '<div class="page" id="pg-logs">'
  + '<div class="page-head"><h1>日志</h1><p>签到、刷新、Key 与调试记录</p></div>'
  + '<div class="card"><h3>最近日志 <button class="btn sm link" data-act="clearlog" style="float:right">清空</button></h3>'
  + '<div class="tbl-scroll"><table><thead><tr><th>时间</th><th>级别</th><th>内容</th></tr></thead>'
  + '<tbody id="logBody"><tr><td colspan="3" class="muted">读取中…</td></tr></tbody></table></div></div>'
  + '</div>'

  + '</div>'

  + '<script>'
  + 'function el(id){return document.getElementById(id)}'
  + 'function escH(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c]})}'
  + 'function getTok(){var m=location.search.match(/[?&]token=([^&]+)/);if(m){try{localStorage.setItem("r2a_tok",decodeURIComponent(m[1]))}catch(e){} return decodeURIComponent(m[1])}'
  + 'try{return localStorage.getItem("r2a_tok")||""}catch(e){return ""}}'
  + 'function api(path,opt){opt=opt||{};var h=opt.headers||{};h["Authorization"]="Bearer "+getTok();opt.headers=h;'
  + 'return fetch(path,opt).then(function(r){return r.json().catch(function(){return {}})})}'
  + 'function fmt(ms){if(!ms)return "—";var d=new Date(Number(ms));return isNaN(d.getTime())?"—":d.toLocaleString("zh-CN",{hour12:false})}'
  + 'function go(p){'
  + 'document.querySelectorAll(".page").forEach(function(x){x.classList.remove("on")});'
  + 'var e=el("pg-"+p);if(e)e.classList.add("on");'
  + 'document.querySelectorAll(".nav button").forEach(function(b){b.classList.toggle("on",b.getAttribute("data-page")===p)});'
  + 'if(p==="dashboard"||p==="accounts"||p==="data")loadOverview();'
  + 'if(p==="settings")loadSettings();'
  + 'if(p==="keys")loadKeys();'
  + 'if(p==="debug"){loadModels();loadGallery();}'
  + 'if(p==="logs")loadLogs();'
  + 'window.scrollTo(0,0);}'
  + 'function rowHtml(a){'
  + 'var pts=(a.points===null||a.points===undefined)?"—":a.points;'
  + 'var exp=a.expired?\'<span class="pill exp">已过期</span>\':\'<span class="pill ok">正常</span>\';'
  + 'var td=a.today==="Y"?\'<span class="pill ok">已签</span>\':\'<span class="pill wait">待签</span>\';'
  + 'var uid=escH(a.UserID||"");'
  + 'return \'<tr><td><div class="name">\'+escH(a.name||a.UserID||"未命名")+\'</div><div class="uid">\'+uid+\'</div></td>\''
  + '+\'<td class="pts">\'+escH(pts)+\'</td>\''
  + '+\'<td class="muted">\'+escH(fmt(a.expiryMs))+\'</td>\''
  + '+\'<td>\'+td+\'</td><td>\'+exp+\'</td>\''
  + '+\'<td style="white-space:nowrap"><button class="btn sm" data-act="ci" data-uid="\'+uid+\'">签到</button> \''
  + '+\'<button class="btn sm link" data-act="bills" data-uid="\'+uid+\'">明细</button>\''
  + '+\'<button class="btn sm link" data-act="del" data-uid="\'+uid+\'">删除</button></td></tr>\'}'
  + 'function loadOverview(){'
  + 'api("/api/admin/overview").then(function(d){'
  + 'if(!d||!d.success)return;var accs=d.accounts||[];'
  + 'if(el("kpiPts"))el("kpiPts").textContent=(d.totalPoints==null?"—":d.totalPoints);'
  + 'if(el("kpiAcc"))el("kpiAcc").textContent=accs.length;'
  + 'if(el("kpiChk"))el("kpiChk").textContent=accs.filter(function(a){return a.today==="Y"}).length;'
  + 'if(el("kpiRate"))el("kpiRate").textContent=(d.rate==null?0:d.rate)+"%";'
  + 'if(el("accSum"))el("accSum").textContent="总积分 "+(d.totalPoints==null?"—":d.totalPoints);'
  + 'var h=accs.length?accs.map(rowHtml).join(""):\'<tr><td colspan="6" class="muted" style="padding:18px 10px">暂无账号</td></tr>\';'
  + '["tbDash","tbAcc","tbData"].forEach(function(id){if(el(id))el(id).innerHTML=h});'
  + '}).catch(function(){});}'
  + 'function loadSettings(){'
  + 'var b=el("setBody");if(!b)return;'
  + 'api("/api/x/settings").then(function(d){'
  + 'if(!d||!d.success){b.innerHTML=\'<tr><td colspan="3" class="muted">读取失败</td></tr>\';return}'
  + 'var h=(d.items||[]).map(function(it){'
  + 'var ph=it.secret?"已设置（留空=不修改，重填=覆盖）":"未设置";'
  + 'var val=it.secret?"":escH(it.value||"");'
  + 'return \'<tr><td><div class="name">\'+escH(it.key)+\'</div></td>\''
  + '+\'<td><input id="set_\'+escH(it.key)+\'" value="\'+val+\'" placeholder="\'+ph+\'" style="width:100%;min-width:150px"></td>\''
  + '+\'<td><button class="btn sm gold" data-act="set" data-key="\'+escH(it.key)+\'" data-secret="\'+(it.secret?1:0)+\'">保存</button></td></tr>\'});'
  + 'b.innerHTML=h.join("")||\'<tr><td colspan="3" class="muted">无</td></tr>\';'
  + '}).catch(function(){b.innerHTML=\'<tr><td colspan="3" class="muted">读取失败</td></tr>\'});}'
  + 'function saveSetting(key,secret){'
  + 'var i=el("set_"+key);var v=i?i.value:"";'
  + 'if(secret&&!v){alert("请填完整值再保存（脱敏值不会被提交）");return}'
  + 'api("/api/x/settings?k="+encodeURIComponent(key)+"&v="+encodeURIComponent(v),{method:"POST"}).then(function(d){'
  + 'alert(d&&d.success?("已保存 "+key+(d.synced?"，已同步 Vercel":(d.local?"，仅本地生效":""))):("保存失败："+((d&&d.error)||"unknown")));'
  + 'if(d&&d.success)loadSettings();});}'
  + 'function loadKeys(){'
  + 'var b=el("keyBody");if(!b)return;'
  + 'api("/api/x/keys").then(function(d){'
  + 'if(!d||!d.success){b.innerHTML=\'<tr><td colspan="3" class="muted">读取失败</td></tr>\';return}'
  + 'var h=(d.items||[]).map(function(k){'
  + 'var kid=k.id||k.key||k.name||"";'
  + 'return \'<tr><td class="name">\'+escH(k.name||"—")+\'</td>\''
  + '+\'<td class="uid">\'+escH(k.key||k.masked||k.value||"—")+\'</td>\''
  + '+\'<td><button class="btn sm link" data-act="delkey" data-id="\'+escH(kid)+\'">删除</button></td></tr>\'});'
  + 'b.innerHTML=h.join("")||\'<tr><td colspan="3" class="muted">还没有 Key</td></tr>\';'
  + '}).catch(function(){b.innerHTML=\'<tr><td colspan="3" class="muted">读取失败</td></tr>\'});}'
  + 'function addKey(){var n=(el("keyName")||{}).value||"";'
  + 'api("/api/x/keys?name="+encodeURIComponent(n.trim()||"default"),{method:"POST"}).then(function(d){'
  + 'if(d&&d.item&&d.item.key){alert("已创建 Key："+d.item.key+"（请自行保存）")}else if(!d||!d.ok){alert("创建失败："+((d&&d.error)||"unknown"))}'
  + 'loadKeys();});}'
  + 'function delKey(id){if(!confirm("删除 Key "+id+" ?"))return;'
  + 'api("/api/x/keys?id="+encodeURIComponent(id),{method:"DELETE"}).then(function(){loadKeys()});}'
  + 'function loadGallery(){var g=el("mGrid");if(!g)return;fetch("/api/x/models").then(r=>r.json()).then(function(d){var arr=(d&&d.data)||[];var c2=el("mCount");if(c2)c2.textContent=arr.length;g.innerHTML="";arr.forEach(function(m){var c=document.createElement("div");c.className="mCard";var n=document.createElement("div");n.className="mName";n.textContent=m.name||m.id;var i=document.createElement("div");i.className="mId";i.textContent=m.id;var mt=document.createElement("div");mt.className="mMeta muted";mt.textContent=m.owned_by||"raccoon";c.appendChild(n);c.appendChild(i);c.appendChild(mt);g.appendChild(c);});}).catch(function(){g.innerHTML="<div class=muted>加载失败</div>"});}'
  + 'function loadModels(){var sel=el("dbgModel");if(!sel)return;'
  + 'api("/api/x/models").then(function(d){'
  + 'var arr=(d&&d.data)||[];sel.innerHTML=arr.map(function(m){return \'<option value="\'+escH(m.id)+\'">\'+escH(m.name||m.id)+\'</option>\'}).join("")||\'<option value="">（无模型）</option>\';'
  + '}).catch(function(){});}'
  + 'function runDebug(){'
  + 'var model=(el("dbgModel")||{}).value||"";var prompt=(el("dbgPrompt")||{}).value||"你好";var tools=(el("dbgTools")||{}).value||"";'
  + 'var out=el("dbgOut");out.textContent="请求中…";'
  + 'var q="/api/x/chat-debug?prompt="+encodeURIComponent(prompt)+"&model="+encodeURIComponent(model);'
  + 'if(tools.trim()){try{JSON.parse(tools);q+="&tools="+encodeURIComponent(tools)}catch(e){out.textContent="工具定义不是合法 JSON";return}}'
  + 'api(q,{method:"POST"}).then(function(d){out.textContent=JSON.stringify(d,null,2)}).catch(function(e){out.textContent="请求失败："+e.message});}'
  + 'function loadLogs(){var b=el("logBody");if(!b)return;'
  + 'api("/api/x/logs?limit=200").then(function(d){'
  + 'var arr=(d&&d.items)||[];'
  + 'var h=arr.map(function(l){'
  + 'var t=l.t||l.time||l.ts||"";var lv=l.level||l.lv||"info";var msg=l.msg||l.message||(typeof l==="string"?l:JSON.stringify(l));'
  + 'return \'<tr><td class="muted" style="white-space:nowrap">\'+escH(t)+\'</td><td>\'+escH(lv)+\'</td><td>\'+escH(msg)+\'</td></tr>\'});'
  + 'b.innerHTML=h.join("")||\'<tr><td colspan="3" class="muted">暂无日志</td></tr>\';'
  + '}).catch(function(){b.innerHTML=\'<tr><td colspan="3" class="muted">读取失败</td></tr>\'});}'
  + 'function ci(uid){'
  + 'api("/api/admin/checkin?uid="+encodeURIComponent(uid),{method:"POST"}).then(function(d){'
  + 'if(d&&d.success){var g=d.granted;var tip="签到成功";if(typeof g==="number"&&g>0)tip+=" +"+g;else tip+="（今日已领过）";'
  + 'if(d.balance!==undefined&&d.balance!==null)tip+="  余额:"+d.balance;alert(tip);}'
  + 'else{alert("签到失败："+((d&&(d.error||d.message))||"unknown"));}'
  + 'loadOverview();});}'
  + 'function del(uid){if(!confirm("删除账号 "+uid+" ?"))return;'
  + 'api("/api/admin/account?uid="+encodeURIComponent(uid),{method:"DELETE"}).then(function(d){'
  + 'alert(d&&d.ok?"已删除":"删除失败");loadOverview();});}'
  + 'function showBills(uid){var box=el("billsBox");if(box)box.textContent="读取中…";'
  + 'go("data");'
  + 'Promise.all([api("/api/admin/balance?uid="+encodeURIComponent(uid)),api("/api/admin/bills?uid="+encodeURIComponent(uid))]).then(function(r){'
  + 'var bal=r[0]||{},bl=r[1]||{};var out="";'
  + 'out+="余额："+((bal.balance===undefined||bal.balance===null)?"—":bal.balance)+"\\n";'
  + 'var list=bl.items||bl.list||bl.data||[];'
  + 'if(Array.isArray(list)&&list.length){out+="\\n最近账单：\\n";list.slice(0,20).forEach(function(it){'
  + 'out+=(it.created_at||it.time||"")+"  "+(it.points!==undefined?it.points:(it.amount||""))+"  "+(it.reason||it.title||it.desc||"")+"\\n"});}'
  + 'else{out+="\\n账单："+(bl.rawText||JSON.stringify(bl).slice(0,800));}'
  + 'if(box)box.textContent=out;'
  + '}).catch(function(e){if(box)box.textContent="读取失败："+e.message});}'
  + 'document.addEventListener("click",function(e){'
  + 'var n=e.target.closest?e.target.closest("[data-page]"):null;'
  + 'if(n){go(n.getAttribute("data-page"));return;}'
  + 'var b=e.target.closest?e.target.closest("[data-act]"):null;if(!b)return;'
  + 'var act=b.getAttribute("data-act");'
  + 'if(act==="ci")ci(b.getAttribute("data-uid"));'
  + 'else if(act==="del")del(b.getAttribute("data-uid"));'
  + 'else if(act==="bills")showBills(b.getAttribute("data-uid"));'
  + 'else if(act==="set")saveSetting(b.getAttribute("data-key"),b.getAttribute("data-secret")==="1");'
  + 'else if(act==="addkey")addKey();'
  + 'else if(act==="delkey")delKey(b.getAttribute("data-id"));'
  + 'else if(act==="dbg")runDebug();'
  + 'else if(act==="clearlog"){if(confirm("清空全部日志?"))api("/api/x/logs",{method:"DELETE"}).then(loadLogs)}'
  + 'else if(act==="addrt"){var v=(el("rtIn")||{}).value||"";if(!v.trim()){alert("请先粘贴 refresh_token");return;}'
  + 'var q="/api/admin/add-by-refresh?refresh_token="+encodeURIComponent(v.trim());'
  + 'api(q,{method:"POST"}).then(function(d){'
  + 'if(d&&d.ok){alert("已接入账号 "+(d.name||d.UserID||""));loadOverview();}'
  + 'else{alert("失败："+((d&&(d.error||d.message))||"unknown"));}});}'
  + '});'
  + 'loadOverview();'
  + '</script></body></html>';
}

async function api(ctx) {
  const u = new URL(ctx.url || '', 'http://x');
  const p = (ctx.path || u.pathname || '');
  const uid = u.searchParams.get('uid') || u.searchParams.get('account') || '';
  const qname = u.searchParams.get('q') || '';
  if (!authed(ctx)) return util.json(ctx.res, 401, { error: 'unauthorized' });
  try {
    // 把当前可见账号（process.env 明文 + env API + 内存）全部重写成 plain 记录。
    // 用途：把历史 encrypted 记录迁移成可运行时读取的明文，修复"重部署后新账号丢失"。
    if (p.endsWith('/sync-env')) {
      try {
        const r = await accounts.syncAllEnv();
        return util.json(ctx.res, 200, { success: true, result: r });
      } catch (e) {
        return util.json(ctx.res, 500, { success: false, error: String((e && e.message) || e) });
      }
    }

    if (p.endsWith('/overview')) {
      const list0 = await accounts.listAccounts();
      const pickPts = (o) => {
        if (!o || typeof o !== 'object') return null;
        for (const k of ['balance','points','total','point','score','available_points','usable_points']) {
          if (o[k] !== undefined && o[k] !== null) return o[k];
        }
        return null;
      };
      const items = await Promise.all(list0.map(async (a) => {
        let points = null, httpStatus = 0, err = null;
        try {
          if (a.accessToken) {
            const r = await checkin.balance(a.accessToken);
            const rd = (r && r.data) || null;
            let bal = pickPts(rd);
            if (bal === null && rd && rd.data) bal = pickPts(rd.data);
            if (bal === null && rd && rd.data && rd.data.data) bal = pickPts(rd.data.data);
            if (bal !== null) { const n = Number(bal); points = isFinite(n) ? n : null; }
            httpStatus = (r && r.status) || 0;
            if (points === null && httpStatus >= 400) err = 'HTTP ' + httpStatus;
          } else { err = 'no accessToken'; }
        } catch (e) { err = e.message; }
        return {
          UserID: a.UserID, name: a.name || '', org: a.org || '',
          points: points, httpStatus: httpStatus, err: err,
          expired: !!a.expired, today: a.today || (a.todayChecked ? 'Y' : 'N'),
          lastCheckin: a.lastCheckin || null, expiryMs: a.expiryMs || 0
        };
      }));
      const totalPoints = items.reduce((sum, it) => sum + ((typeof it.points === 'number' && isFinite(it.points)) ? it.points : 0), 0);
      const checkedToday = items.filter(i => i.today === 'Y').length;
      const expired = items.filter(i => i.expired).length;
      return util.json(ctx.res, 200, {
        success: true, totalPoints: totalPoints, accounts: items,
        stats: { total: items.length, checkedToday: checkedToday, expired: expired,
                 rate: items.length ? Math.round(checkedToday / items.length * 100) : 0 }
      });
    }
    if (p.endsWith('/accounts')) {
      let list = await accounts.listAccounts();
      if (qname) list = list.filter(a => (a.name||'').includes(qname) || (a.UserID||'').includes(qname));
      return util.json(ctx.res, 200, { success: true, accounts: list.map(a => ({
        UserID: a.UserID, name: a.name, org: a.org||'', expiryMs: a.expiryMs||0,
        expired: !!a.expired, lastCheckin: a.lastCheckin||null, todayChecked: a.todayChecked,
        today: a.today||(a.todayChecked? 'Y':'N'), updatedAt: a._mtime||0
      }))});
    }
    if (p.endsWith('/balance')) {
      if (!uid) return util.json(ctx.res, 400, { error: 'missing uid' });
      const acc = await accounts.getAccount(uid);
      if (!acc) return util.json(ctx.res, 404, { error: 'no such account' });
      const r = await checkin.balance(acc.accessToken);
      const pick = (o) => {
        if (!o || typeof o !== 'object') return null;
        for (const k of ['balance','points','total','point','score','available_points','usable_points']) {
          if (o[k] !== undefined && o[k] !== null) return o[k];
        }
        return null;
      };
      const rd = (r && r.data) || null;
      let bal = pick(rd);
      if (bal === null && rd && rd.data) bal = pick(rd.data);
      if (bal === null && rd && rd.data && rd.data.data) bal = pick(rd.data.data);
      return util.json(ctx.res, 200, {
        success: true, balance: bal,
        httpStatus: (r && r.status) || 0,
        rawText: (r && r.rawBody ? String(r.rawBody).slice(0, 1500) : ''),
        account: { UserID: acc.UserID, name: acc.name }
      });
    }
    if (p.endsWith('/bills')) {
      if (!uid) return util.json(ctx.res, 400, { error: 'missing uid' });
      const acc = await accounts.getAccount(uid);
      if (!acc) return util.json(ctx.res, 404, { error: 'no such account' });
      try {
        const r = await checkin.bills(acc.accessToken, 20, 0);
        const rd = (r && r.data) || {};
        const rd2 = rd.data || rd;
        const findList = (o) => {
          if (!o) return null;
          if (Array.isArray(o)) return o;
          for (const k of ['records','list','items','bills','rows','data']) {
            if (Array.isArray(o[k])) return o[k];
          }
          if (o.data && typeof o.data === 'object') return findList(o.data);
          return null;
        };
        const list = findList(rd2) || findList(rd) || [];
        return util.json(ctx.res, 200, {
          success: true, bills: list.slice(0, 20),
          httpStatus: (r && r.status) || 0,
          rawText: (r && r.rawBody ? String(r.rawBody).slice(0, 1500) : '')
        });
      } catch (e) {
        return util.json(ctx.res, 502, { success: false, error: e.message });
      }
    }
    if (p.endsWith('/checkin')) {
      if (!uid) return util.json(ctx.res, 400, { error: 'missing uid' });
      const acc = await accounts.getAccount(uid);
      if (!acc) return util.json(ctx.res, 404, { error: 'no such account' });
      // accessToken 为空但有 refreshToken 时，先 refresh 补票，不要直接判失败
      if (!acc.accessToken && !acc.refreshToken) {
        return util.json(ctx.res, 400, { success: false, error: 'account has no accessToken and no refreshToken' });
      }
      // 签到前先 refresh：桌面登录奖励按「当日登录」发放，旧 token 会被判 granted:false。
      // 用 refreshToken 换一个新鲜 accessToken（模拟今日登录）并落盘，再用新 token grant。
      let token = acc.accessToken;
      let refreshed = false;
      if (acc.refreshToken) {
        try {
          const rr = await auth.refresh(acc.refreshToken);
          if (rr && rr.ok && rr.data && rr.data.accessToken) {
            acc.accessToken = rr.data.accessToken;
            if (rr.data.refreshToken) acc.refreshToken = rr.data.refreshToken;
            if (rr.data.expiryMs) acc.expiryMs = rr.data.expiryMs;
            token = rr.data.accessToken;
            try { await accounts.saveAccount(acc); } catch(_){}
          }
        } catch(_){}
      }
      if (!token) {
        return util.json(ctx.res, 500, {
          success: false,
          error: 'refresh 后仍未拿到 accessToken',
          refreshed,
        });
      }
      const g = await checkin.grant(token);
      // 兼容多种返回形态：{data:{data:{granted}}}, {data:{granted}}, {granted}
      const gd = (g && g.data) || g || {};
      const gd2 = (gd && gd.data) || gd;
      let granted = (gd2 && gd2.granted !== undefined) ? gd2.granted : (gd && gd.granted);
      if (typeof granted === 'string' && granted !== '') granted = (granted === 'true' ? true : (granted === 'false' ? false : granted));
      const gcode = (gd && (gd.code !== undefined ? gd.code : gd.status)) || (g && g.code);
      // 判断 grant 是否失败（HTTP 非 2xx 或 code 非 0/200）
      const httpStatus = (g && (g.status || g.statusCode)) || 200;
      const failed = (httpStatus >= 400) || (gd && gd.code !== undefined && gd.code !== 0 && gd.code !== 200);
      // 回查余额（token 有效时总能拿到）
      let bal = null;
      try { const br = await checkin.balance(acc.accessToken); const bd=(br&&br.data)||{}; const pick2=(o)=>{if(!o||typeof o!=='object')return null;for(const k of ['balance','points','total','point','score','available_points']){if(o[k]!==undefined&&o[k]!==null)return o[k];}return null;}; bal=pick2(bd); if(bal===null&&bd.data)bal=pick2(bd.data); if(bal===null&&bd.data&&bd.data.data)bal=pick2(bd.data.data); } catch(e){}
      // ---- 按 APK checkin(543行) 真实语义判定 ----
      // success = 今日账单里入账积分 > 0（这才是「今天拿到分了」）
      // granted 只是 grant 接口自己的布尔返回，web 会话永远 false，不能用来判成败
      let todayPoints = 0;
      let dailyPoints = 0;
      let todayGrants = [];
      let checkReason = '';
      try {
        const cr = await checkin.checkTodayGranted(acc.accessToken);
        if (cr && cr.found) { todayPoints = cr.point || 0; }
        if (cr && cr.dailyPoint) { dailyPoints = cr.dailyPoint; }
        if (cr && Array.isArray(cr.grants)) todayGrants = cr.grants;
        if (cr && cr.reason) checkReason = cr.reason;
      } catch (_) {}
      const gotPoints = todayPoints > 0;
      // 只要今天有入账就记为已签到
      if (!failed && gotPoints) {
        acc.todayChecked = true;
        acc.lastCheckin = Date.now();
        try { await accounts.saveAccount(acc); } catch(e){}
      }
      // 文案（对齐 APK 524-536 行三种情况）
      let msg;
      if (failed) msg = '桌面登录奖励未领取';
      else if (dailyPoints > 0) msg = '今日每日积分已发放 +' + dailyPoints;
      else if (gotPoints) msg = '今日已入账 +' + todayPoints + '（礼包/奖励类）';
      else msg = checkReason || '今日未见积分入账（可能已领取）';
      return util.json(ctx.res, failed ? 502 : 200, {
        success: !failed,
        gotPoints: gotPoints,
        todayPoints: todayPoints,
        dailyPoints: dailyPoints,
        todayGrants: todayGrants,
        granted: granted,
        balance: bal,
        code: gcode,
        httpStatus: httpStatus,
        msg: msg,
        error: failed ? ((gd && (gd.message||gd.msg)) || ('grant failed (code='+gcode+')')) : undefined,
        rawText: (g && g.rawBody ? String(g.rawBody).slice(0, 1500) : '')
      });
    }
    if (p.endsWith('/add-by-refresh') && (ctx.method||'').toUpperCase() === 'POST') {
      // 只贴 refresh_token 换账号：调 /refresh 换出 accessToken + 新refreshToken，存账号
      // 优先从 query/header 读（避免依赖 body 流），再 fallback 到 body
      const uq = new URL(ctx.url || '', 'http://x');
      let rt = uq.searchParams.get('refresh_token') || uq.searchParams.get('rt') || (ctx.headers && ctx.headers['x-refresh-token']) || '';
      if (!rt) {
        try { const body = await util.readBody(ctx.req).then(b => { try { return JSON.parse(b||'{}'); } catch(_){ return {}; } });
          rt = (body && (body.refresh_token || body.refreshToken || body.rt)) || '';
        } catch(_) {}
      }
      if (!rt) return util.json(ctx.res, 400, { error: 'missing refresh_token' });
      const r = await auth.refresh(rt);
      if (!r || !r.ok) {
        return util.json(ctx.res, 400, { ok: false, error: (r && (r.message || r.code)) || 'refresh failed' });
      }
      const d = r.data || {};
      const user = d.user || {};
      // 上游必须真的给回 accessToken，否则存进去就是空号（签到会报 account has no accessToken）
      if (!d.accessToken) {
        return util.json(ctx.res, 502, {
          ok: false, success: false,
          error: 'refresh 成功但上游未返回 access_token',
          keys: Object.keys(d.raw || d || {}).slice(0, 20),
          rawText: r.raw ? JSON.stringify(r.raw).slice(0, 800) : '',
        });
      }
      // UserID 取 JWT 里的 id/uid/UserID，兜底用 name 或时间戳
      let uid = user.UserID || user.uid || user.id || user.userId || user.sub || '';
      const name = user.name || user.nickname || user.nickName || '';
      if (!uid) uid = 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2,6);
      const expireMs = d.expiresIn ? (Date.now() + d.expiresIn*1000) : (Date.now() + 7*24*3600*1000);
      const acc = {
        v: 2, UserID: uid,
        name: name || uid,
        org: user.org || user.officeIdentity || '',
        accessToken: d.accessToken || '',
        refreshToken: d.refreshToken || rt,
        expiryMs: expireMs,
        todayChecked: false, lastCheckin: null,
        _mtime: Date.now(),
      };
      const saved = await accounts.saveAccount(acc);
      return util.json(ctx.res, 200, { ok: true, success: true, UserID: uid, name: name || uid, account: saved ? { UserID: saved.UserID, name: saved.name } : null });
    }

    if (p.endsWith('/account') && (ctx.method||'').toUpperCase() === 'DELETE') {
      if (!uid) return util.json(ctx.res, 400, { error: 'missing uid' });
      await accounts.deleteAccount(uid);
      return util.json(ctx.res, 200, { success: true, ok: true });
    }
    return util.json(ctx.res, 404, { error: 'not found' });
  } catch (e) {
    return util.json(ctx.res, 500, { error: String((e && e.message) || e) });
  }
}

async function route(ctx) {
  const u = new URL(ctx.url || '', 'http://x');
  const token = u.searchParams.get('token') || '';
  const qAuthed = authed(ctx);
  if (!qAuthed) return util.html(ctx.res, 200, renderLogin());
  let list = [];
  try { list = await accounts.listAccounts(); } catch(e) { list = []; }
  return util.html(ctx.res, 200, renderPanel(list));
}

module.exports = { route, api, renderLogin, renderPanel };
