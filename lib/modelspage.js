// 模型展示页 /models —— 卡片式列出账号可用模型（含计费 credits）
// 数据来自 /api/x/models；鉴权可用 ?token= 传入管理员口令
const util = require('./util');

const ADMIN_TOKEN = process.env.RACCOON_ADMIN_TOKEN || '';

function page(ctx) {
  const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>小浣熊 · 可用模型</title>
<style>
:root{
  --bg:#1a1a19; --bg-1:#1e1e1d; --bg-2:#232322; --bg-3:#2a2a28; --bg-inset:#161615;
  --line:#302f2d; --line-2:#282826; --line-3:#3a3937;
  --ink:#ded9d1; --ink-2:#a8a29a; --ink-3:#7b756d; --ink-4:#5d5852;
  --gold:#b9a173; --gold-1:#cdb98f; --gold-2:#9a845e;
  --violet:#948cb5; --ok:#7fa98b; --err:#bb8585; --warn:#c0a273;
}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;font-size:14px;line-height:1.6;-webkit-font-smoothing:antialiased}
.wrap{max-width:760px;margin:0 auto;padding:20px 14px 60px}
.head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:18px}
.head h1{font-size:17px;font-weight:600;letter-spacing:.02em;color:var(--gold-1)}
.head .sub{font-size:11.5px;color:var(--ink-4);margin-top:3px}
.head .cnt{font-size:11.5px;color:var(--ink-3);border:1px solid var(--line-3);border-radius:20px;padding:4px 11px;white-space:nowrap}
.list{display:flex;flex-direction:column;gap:10px}
.card{background:var(--bg-2);border:1px solid var(--line-2);border-radius:14px;padding:15px 16px;transition:border-color .15s,transform .15s}
.card:hover{border-color:var(--line-3);transform:translateY(-1px)}
.row1{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
.mname{font-size:15px;font-weight:600;color:var(--ink);letter-spacing:.01em;word-break:break-word}
.credits{font-size:12.5px;color:var(--gold);white-space:nowrap;padding-top:2px;font-variant-numeric:tabular-nums}
.mid{font-size:12px;color:var(--violet);margin-top:4px;word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.desc{font-size:12.8px;color:var(--ink-2);margin-top:8px;line-height:1.65}
.meta{display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:9px;font-size:11.8px;color:var(--ink-3)}
.meta b{color:var(--ink-2);font-weight:600}
.tags{display:flex;flex-wrap:wrap;gap:5px;margin-top:9px}
.tag{font-size:10.8px;color:var(--ink-3);background:var(--bg-3);border:1px solid var(--line-2);border-radius:5px;padding:2px 7px;letter-spacing:.02em}
.img{color:var(--ok);border-color:rgba(127,169,139,.3);background:rgba(127,169,139,.08)}
.empty{text-align:center;color:var(--ink-4);padding:50px 20px;font-size:13px}
.errbox{margin-top:14px;padding:12px 14px;border:1px solid rgba(187,133,133,.3);background:rgba(187,133,133,.08);border-radius:10px;color:var(--err);font-size:12.3px;word-break:break-all}
.foot{margin-top:26px;text-align:center;font-size:11px;color:var(--ink-4)}
@media(max-width:480px){
  .wrap{padding:16px 11px 50px}
  .card{padding:13px 13px;border-radius:12px}
  .mname{font-size:14px}
  .desc{font-size:12.3px}
  .head h1{font-size:16px}
  .meta{gap:5px 11px;font-size:11.3px}
}
</style></head><body>
<div class="wrap">
  <div class="head">
    <div>
      <h1>可用模型</h1>
      <div class="sub">RACCOON2API · MODEL CATALOG</div>
    </div>
    <div class="cnt" id="cnt">—</div>
  </div>
  <div class="list" id="list"><div class="empty">加载中…</div></div>
  <div class="foot">raccoon2api-vercel · 小浣熊办公版网关</div>
</div>
<script>
(function(){
  function esc(s){
    return String(s==null?'':s).replace(/[&<>"']/g,function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }
  function fmtNum(n){
    if(n==null) return '—';
    n=Number(n);
    if(!isFinite(n)) return '—';
    if(n>=1000000) return (n/1000000)+'M';
    if(n>=1000) return (n/1000)+'K';
    return String(n);
  }
  var tok='';
  try{ tok=new URLSearchParams(location.search).get('token') || localStorage.getItem('r2a_tok') || ''; }catch(e){}
  if(tok){ try{ localStorage.setItem('r2a_tok', tok); }catch(e){} }
  var url='/api/x/models' + (tok ? ('?token='+encodeURIComponent(tok)) : '');
  fetch(url).then(function(r){ return r.json(); }).then(function(d){
    var arr=(d && d.data) || [];
    var list=document.getElementById('list');
    var cnt=document.getElementById('cnt');
    cnt.textContent = arr.length + ' 个模型';
    if(!arr.length){ list.innerHTML='<div class="empty">暂无模型（账号 token 可能已失效，或尚未添加账号）</div>'; return; }
    list.innerHTML = arr.map(function(m){
      var name = m.name || m.id || '';
      var credits = m.credits || '';
      var tags = Array.isArray(m.tags) ? m.tags : [];
      var tagHtml = tags.slice(0,12).map(function(t){
        var isImg = (t==='vision'||t==='image'||t==='image-understanding');
        return '<span class="tag'+(isImg?' img':'')+'">'+esc(t)+'</span>';
      }).join('');
      if(m.supportsImages && tags.indexOf('vision')<0 && tags.indexOf('image')<0)
        tagHtml = '<span class="tag img">图片</span>' + tagHtml;
      return '<div class="card">'
        + '<div class="row1">'
        +   '<div class="mname">'+esc(name)+'</div>'
        +   (credits ? '<div class="credits">'+esc(credits)+'</div>' : '')
        + '</div>'
        + '<div class="mid">'+esc(m.id||'')+'</div>'
        + (m.description ? '<div class="desc">'+esc(m.description)+'</div>' : '')
        + '<div class="meta">'
        +   '<span>上下文 <b>'+fmtNum(m.contextWindow)+'</b></span>'
        +   '<span>输出 <b>'+fmtNum(m.maxTokens)+'</b></span>'
        + '</div>'
        + (tagHtml ? '<div class="tags">'+tagHtml+'</div>' : '')
        + '</div>';
    }).join('');
  }).catch(function(e){
    document.getElementById('list').innerHTML =
      '<div class="empty">加载失败：'+esc(e && e.message || e)+'</div>';
  });
})();
</script>
</body></html>`;
  return util.html(ctx.res, 200, html);
}

module.exports = { page };
