# 部署手册

目标：把 lx-source-watch 部署成「Cloudflare Worker 看板 + GitHub Actions 探测/测活/订阅拉取」的线上服务。命令默认在仓库根目录执行；本机 pnpm 不在 PATH 时统一用 `corepack pnpm`。

当前线上参考：<https://dash.dpdns.org>（整站登录）。

---

## 0. 前置条件

| 项 | 要求 |
|---|---|
| GitHub | 公开仓库 `lx-source-watch`；默认分支 `main` |
| GitHub PAT | 部署用 `CF_API_TOKEN` 存在 Actions secret；仓库写权限只用于本机推送 |
| Cloudflare | 账号 + 已托管到该账号的域名（自定义域需要） |
| 本地 | Node 22+、pnpm 11（`corepack enable` 或直接用 `corepack pnpm`） |

Cloudflare 资源：

- KV：`SNAPSHOT`，只存最新快照与运行日志。
- D1：`lx-source-watch`，存历史、任务、代理、订阅、候选、设置。
- Worker：`lx-source-watch`，静态资源来自 `apps/web/dist`。

---

## 1. 登录 Cloudflare

任选一种：

```powershell
corepack pnpm --filter @lx/worker exec wrangler login
```

或使用 API Token（推荐 CI/无浏览器环境）：

```powershell
$env:CLOUDFLARE_API_TOKEN = '<token>'
$env:CLOUDFLARE_ACCOUNT_ID = '<account id>'
corepack pnpm --filter @lx/worker exec wrangler whoami
```

Token 权限：Workers Scripts 编辑、KV 编辑、D1 编辑、Account Analytics 读；自动部署还需要能写 Worker 自定义域。

---

## 2. 创建 KV 与 D1

```powershell
corepack pnpm --filter @lx/worker exec wrangler kv namespace create SNAPSHOT
corepack pnpm --filter @lx/worker exec wrangler d1 create lx-source-watch
```

把输出的 `id` / `database_id` 填入 `apps/worker/wrangler.jsonc`。仓库里的值是维护者线上实例的 ID；部署自己的实例必须换成你刚创建的值，不要直接复用。

```jsonc
"kv_namespaces": [
  { "binding": "SNAPSHOT", "id": "<KV namespace id>" }
],
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "lx-source-watch",
    "database_id": "<D1 database id>",
    "migrations_dir": "migrations"
  }
]
```

同时把 `CF_ACCOUNT_ID`、`D1_ID` 两个 var 改成自己的值。`database_name` 必须保持 `lx-source-watch`，迁移命令按名字找库。

自定义域在 `routes` 里：

```jsonc
"routes": [{ "pattern": "dash.example.com", "custom_domain": true }]
```

---

## 3. 远程建表

```powershell
corepack pnpm --filter @lx/worker exec wrangler d1 migrations apply lx-source-watch --remote
```

迁移从 `0001_init.sql` 到 `0021_discovery_repos.sql`，应全部成功。验证：

```powershell
corepack pnpm --filter @lx/worker exec wrangler d1 execute lx-source-watch --remote --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
```

应包含：`candidates`、`events`、`platform_daily`、`platform_results`、`proxy_subscriptions`、`proxy_test_results`、`proxy_test_runs`、`proxies`、`runs`、`settings`、`source_aliases`、`source_daily`、`source_endpoints`、`source_registry`、`source_runs`、`sources`、`task_locks`、`task_state`、`tasks`。

新增迁移必须提交并在部署前应用；否则新代码查询会报 `no such column`。

---

## 4. 设置 Worker 机密

共 7 个：

| Secret | 用途 |
|---|---|
| `INGEST_SECRET` | Actions 上报 HMAC，必须与 GitHub secret 一致 |
| `RUNNER_TOKEN` | Actions 读取代理池、运行参数、回传测活/订阅结果 |
| `PROXY_ENC_KEY` | 代理密码/内核配置 AES-GCM 加密（32 字节 base64） |
| `ADMIN_PASSWORD_HASH` | 管理员密码 PBKDF2 哈希 |
| `SESSION_SECRET` | 会话 Cookie HMAC |
| `GH_DISPATCH_TOKEN` | Worker 派发 GitHub workflow（Actions 读写） |
| `CF_ANALYTICS_TOKEN` | 读取 KV/D1 用量；可用具备 Account Analytics 读权限的部署令牌代替 |

逐个写入（在仓库根目录执行；`--filter` 会让 wrangler 在 `apps/worker` 下运行）：

```powershell
corepack pnpm --filter @lx/worker exec wrangler secret put INGEST_SECRET
corepack pnpm --filter @lx/worker exec wrangler secret put RUNNER_TOKEN
corepack pnpm --filter @lx/worker exec wrangler secret put PROXY_ENC_KEY
corepack pnpm --filter @lx/worker exec wrangler secret put ADMIN_PASSWORD_HASH
corepack pnpm --filter @lx/worker exec wrangler secret put SESSION_SECRET
corepack pnpm --filter @lx/worker exec wrangler secret put GH_DISPATCH_TOKEN
corepack pnpm --filter @lx/worker exec wrangler secret put CF_ANALYTICS_TOKEN
```

生成随机串（用系统加密随机源）：

```powershell
# 32 字节 hex：INGEST_SECRET / RUNNER_TOKEN / SESSION_SECRET
$b = [byte[]]::new(32)
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
($b | ForEach-Object { $_.ToString('x2') }) -join ''

# 32 字节 base64：PROXY_ENC_KEY
$k = [byte[]]::new(32)
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($k)
[Convert]::ToBase64String($k)
```

生成管理员密码哈希（PBKDF2-SHA256，10 万轮，Workers 上限）：

```powershell
$password = '你的密码'
$salt = [byte[]]::new(16)
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($salt)
$kdf = [System.Security.Cryptography.Rfc2898DeriveBytes]::new(
  $password, $salt, 100000, [System.Security.Cryptography.HashAlgorithmName]::SHA256
)
$hash = $kdf.GetBytes(32)
'pbkdf2$sha256$100000${0}${1}' -f [Convert]::ToBase64String($salt), [Convert]::ToBase64String($hash)
```

把整行 `pbkdf2$...` 输出写入 `ADMIN_PASSWORD_HASH`。该格式与 Worker 的 `auth.ts` 一致；轮数不要超过 100000，否则 Workers WebCrypto 会报 `iteration counts above 100000 are not supported`。管理员密码不要提交、不要发聊天。

---

## 5. 构建与部署

本地手动部署：

```powershell
corepack pnpm --filter @lx/web build
corepack pnpm --filter @lx/worker exec wrangler deploy
```

自动部署：`.github/workflows/deploy.yml` 在 push 到 `main` 且改动涉及 `apps/worker/**`、`apps/web/**`、`packages/shared/**`、依赖或 workflow 时触发。它需要仓库 Actions secret：

| Name | 用途 |
|---|---|
| `CF_API_TOKEN` | 部署 Worker + 同步 `CF_ANALYTICS_TOKEN` |

`apps/runner/**` 的改动不会触发 Worker 部署；测活/探测 workflow 每次运行都会检出最新代码。

自检：

```powershell
curl.exe -s https://dash.example.com/api/health
```

首次部署时 `sources=0` 正常，等第一轮上报后变 19。

---

## 6. 配置 GitHub Actions

仓库 Settings → Secrets and variables → Actions：

| Name | 值 |
|---|---|
| `CF_API_TOKEN` | 部署令牌（见第 5 节） |
| `INGEST_SECRET` | 与 Worker 相同 |
| `INGEST_URL` | `https://dash.example.com/api/ingest` |
| `RUNNER_TOKEN` | 与 Worker 相同 |

`GITHUB_TOKEN` 由 Actions 自动提供，不需要手动添加；自动发现用它读仓库文件树，只在该 step 使用。

工作流：

| 文件 | 触发 | 说明 |
|---|---|---|
| `deploy.yml` | push main / 手动 | 构建前端、同步统计令牌、部署 Worker |
| `probe.yml` | Worker 派发 / 手动 | 探测（无密钥）→ 国内补测（RUNNER_TOKEN）→ 上报（INGEST_SECRET） |
| `proxy-test.yml` | Worker 派发 / 手动 | 代理测活，逐节点回传 |
| `proxy-fetch-sub.yml` | Worker 派发 / 手动 | 经 Actions 拉取 403 订阅并回传 |

手动跑第一轮：Actions → 「音源探测」→ Run workflow，`limit` 填 `3`，`cn` 可先关，确认 `publish` 日志出现 `ingest ok`。

---

## 7. 首次验收

- [ ] `GET /api/health` 返回 `ok=true`，`sources=19`、`candidates>=0`
- [ ] 登录页可用，错误密码返回 401
- [ ] `GET /api/status` 有快照，`stale=false`
- [ ] 运行列表有记录，详情能打开三级明细
- [ ] 接入点表有「国内」列（无代理时显示未测）
- [ ] `/api/admin/proxies/preview` 只统计不写库
- [ ] 重复上报同一 `runId` 返回 `duplicate:true`
- [ ] 错误 HMAC 返回 401 `bad_signature`
- [ ] 403 订阅刷新返回 502 `fetch_forbidden` + `needsRunner`
- [ ] 设置页保存/重置额度护栏；`/api/runner/config` 无令牌 401
- [ ] `/admin` 清理预览计数正确，执行后最新一轮仍可打开
- [ ] Cloudflare 控制台 KV 写约为每轮 1 次；D1 写未超过护栏

---

## 8. 定时与设置

- GitHub workflow 不配置 `schedule`；Worker cron `*/5 * * * *` 到点后派发。
- 探测默认 4h、测活 6h、发现 12h；每轮源数、并发、deep、国内补测、自动收录、保留天数都在设置页改，存 D1。
- 手动触发时间参与“下次到期”计算；派发失败会写任务/运行记录。
- 当前线上为手动触发（三个定时任务关闭）；新部署默认开启，建议先手动跑一轮确认额度与耗时，再决定间隔。
- 额度护栏默认 KV 920/1000、D1 90000/100000；达到阈值暂停派发，可在设置页调低。

---

## 9. 国内代理与订阅

- 代理/订阅在 `/admin/proxies` 管理；密码与内核配置用 `PROXY_ENC_KEY` 加密，页面只显示掩码。
- 支持 URI、`host:port`、JSON、Clash YAML、Base64、QX/Surge/Loon 单行、订阅 URL、文件导入。
- 导入先「预览」：显示总数、新增、已存在、内核数、协议分布、样例与告警；确认后才写库。
- 测活在 `/admin/proxy-tests` 看轮次与逐节点结果；Windows 本地不能跑 mihomo，内核节点需在 Actions 验证。
- 订阅刷新被 403 时，行内「用 Actions 拉取」会高亮；也可在 Actions 手动跑 `proxy-fetch-sub.yml`。
- 国内补测默认只测失败/未测地址；接入点补测独立写 `endpoint.cn`，不改变总状态。
- 代理池为空或全部失败时，cn job 输出中文原因并跳过，不影响探测主结果。

---

## 10. 排障

| 现象 | 排查 |
|---|---|
| `bad_signature` | Worker 与 GitHub 的 `INGEST_SECRET` 不一致 |
| `INGEST_URL` 为空被跳过 | 仓库 secret 名写错或未配置 |
| `/api/status` 503 | KV 还没有 `snapshot:latest`；先跑一轮 probe + publish |
| `stale=true` | 最近一轮超过阈值；检查 Actions/定时任务是否开启 |
| Worker 部署报 D1 找不到 | `database_name` 与迁移命令不一致 |
| `no such column` | 远程迁移未应用；补跑 `d1 migrations apply` |
| 域名 522/1016 | 自定义域 DNS 冲突；不要手工加 A 记录 |
| 登录 500 `iteration counts above 100000` | 密码哈希轮数超过 Workers 上限；重新生成 ≤100000 的哈希 |
| 订阅刷新 403 | 正常兜底；用 Actions 拉取，或换 UA/headers/粘贴 |
| 测活一直 running | 看 Actions 是否失败；任务有 45 分钟看门狗 |
| 内核节点全失败 | 域名失效/IPv6/跨境端口限制；看测活错误和 mihomo 日志尾部 |

---

## 11. 回滚

- Worker：`wrangler deployments list` 找上一版，`wrangler rollback <deployment-id>`。
- 代码：`git revert` 后重新部署；探测逻辑在 `apps/runner`，与展示层解耦。
- 数据：删除前先 `wrangler d1 export` 备份；`/admin` 的清理只删旧于截止时间的记录，永远保留最新一轮，并同时清理过期操作记录。
- 迁移：D1 不支持自动回滚；新增列一般保留，回滚代码不删除列。

---

## 12. 成本与额度

- KV：每轮 1 次快照写 + 运行日志（短 TTL）；远低于 1000/天。
- D1：每轮逐源/接入点/平台/日汇总写入；19 源约数千行/天，护栏默认 9 万/天。
- Actions：公开仓库免费；探测约 1–2 分钟/轮，测活约 3 分钟/轮。
- 代理流量：只走用户代理，不经过 Cloudflare；平台补测只读前 256KB，接入点补测只读前 64KB。
