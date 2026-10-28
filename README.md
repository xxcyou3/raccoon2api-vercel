
# raccoon2api-vercel

**小浣熊办公版网关**（纯 Vercel serverless，零 npm 依赖）。

替换 `小浣熊_1.15.apk`（raccoon2api 网关工程）的核心能力：
- **扫码换票**：微信扫码 → 授权回调 `code` → 换 `accessToken + refreshToken`，写入环境变量（每账号一条，可多账号、可重扫）。
- **Token 生命周期**：过期自动用 `refreshToken` 轮换，新票落盘（写前拉远端合并，防多实例丢号）。
- **每日自动签到**：Vercel Cron 每天 1 点触发，幂等（当天已入账跳过）、迟到可补签、失败当日上限防风控。
- **OpenAI 兼容网关**：`/v1/chat/completions`（含 SSE 流式透传）+ `/v1/models`，把账号的 `accessToken` 代理成标准 LLM API。

> ⚠️ 登录链路说明：本次实现走两条路——①网页版扫码（打开 `/code/authorize` 授权页 → 微信扫码 → 回调带 `code`）；②手动粘贴授权 `code` 备选。APK 原生的 `office-raccoon://` 深链是 Android 自定义 scheme，纯网页无法拦截捕获，故未复刻该深链，改用手动贴 code + 网页授权页两路。

## 目录结构

```
api/index.js        单入口路由（Vercel handler），全路由分派
lib/net.js          Node 原生 HTTP 助手（含 requestStream 供 SSE 透传）
lib/auth.js         换票 / 刷新 / JWT 解析
lib/checkin.js      签到 / 余额 / 账单 / 设置（严格照 APK 反编译协议）
lib/accounts.js     账号存储：每账号一条 env 变量 + 墓碑 + 写前合并防丢号
lib/cron.js         每日自动签到（/api/cron/maintain）
lib/login.js        /login 扫码页 + /submit-code 手动 code 换票
lib/openai.js       OpenAI 兼容网关（/v1/chat/completions + /v1/models）
lib/admin.js        Web 管理面板 + /api/admin/* REST
dev-server.js       本地开发服务器（复用路由）
deploy_vercel.js    用 Vercel REST API 内联部署（无需 CLI/npm）
vercel.json         路由 + Cron 配置
```

## 部署到 Vercel

### 方式 A：脚本部署（推荐）
```bash
cd /workspace/raccoon2api-vercel
VERCEL_TOKEN=<你的token> VERCEL_PROJECT=raccoon2api-vercel node deploy_vercel.js
```
首次会自动创建项目，之后覆盖部署到 production。环境变量需在 Vercel 控制台单独配（见下）。

### 方式 B：Vercel CLI / Git 推送
项目根目录（`api/index.js` + `vercel.json`）直接推仓库或 `vercel deploy --prod` 即可。

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `RACCOON_ADMIN_TOKEN` | 建议 | 管理面板 + 管理 API 的访问口令（不回显） |
| `RACCOON_API_TOKEN` | 建议 | OpenAI 网关的外部调用口令（客户端 `Authorization: Bearer`） |
| `RACCOON_CRON_SECRET` | 建议 | Cron 触发口令（`/api/cron/maintain?key=`） |
| `RACCOON_AUTH_BASE` | 否 | 默认 `https://xiaohuanxiong.com/api/web/auth/v1` |
| `RACCOON_MAIN_ORIGIN` | 否 | 默认 `https://xiaohuanxiong.com` |
| `RACCOON_LLM_BASE` | 否 | 默认 `https://xiaohuanxiong.com/api/web/llm/v2` |
| `RACCOON_PLATFORM` | 否 | 签到 `X-Client-Platform`，默认 `desktop-windows` |
| `RACCOON_VERSION` | 否 | 签到 `X-Client-Version`，默认 `v1.0.0` |
| `RACCOON_ACCT_<uid>` | 动态 | **每账号一条**，存 `{UserID,name,accessToken,refreshToken,expiryMs,_mtime,...}`，由 /login 自动写入 |

> 本机/docker 运行时（dev-server），账号自动降级存本地文件，便于测试；Vercel 上走 env API。

## 使用

1. 打开 `https://<你的域名>/login` → 点「打开授权页扫码」或用「②手动贴 code」
2. 扫码/贴 code → 自动换票 → 账号写入环境变量 `RACCOON_ACCT_<uid>`
3. 管理：打开 `/admin`（输 ADMIN_TOKEN）→ 看账号列表、查积分、手动签到、删账号
4. 网关：
   ```bash
   curl https://<域名>/v1/chat/completions \
     -H "Authorization: Bearer $RACCOON_API_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"model":"raccoon-8c4485","messages":[{"role":"user","content":"你好"}],"stream":true}'
   ```
   默认走第一个账号；多账号用 `?account=<uid>` 指定。

## 本地测试

```bash
cd /workspace/raccoon2api-vercel
node dev-server.js 3000
# 然后
curl http://localhost:3000/health
curl http://localhost:3000/login
curl http://localhost:3000/admin
curl http://localhost:3000/v1/models
```

## 实测状态

| 项 | 状态 |
|---|---|
| 路由连通（/health /login /admin /v1/models /） | ✅ 本地实测通过（HTTP 200） |
| 各模块语法校验 | ✅ 全部通过 |
| 换票 / 刷新 / 签到 / 余额 真实上游调用 | ⏳ 需上线后拿真实小浣熊账号验证（本地无账号 token） |
| OpenAI 网关真实对话 | ⏳ 需上线后验证 |

## 协议来源

全部端点/参数/鉴权头来自对 `小浣熊_1.15.apk` 的反编译（`/workspace/wanx/java/dev/raccoon2api/provider/*.java`），配合公开接口结构参考 `github.com/xxhhlk/raccoon2api`。修改协议前请先读反编译产物确认，勿凭记忆改端点。
