# 部署手册（P3.5）

目标：把一个本地已验证的 lx-source-watch 部署成「GitHub Actions 定时探测 → Cloudflare Worker 接收 → KV/D1 展示」的线上服务。

下面命令默认在仓库根目录执行：

```powershell
cd C:\Users\Administrator\Documents\deepseek-harness\default-workspace\lx-source-watch
```

本机 pnpm 不在 PATH，统一用 `$pnpm` 变量：

```powershell
$node = 'C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$pnpm = 'C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs'
$wrangler = '.\apps\worker\node_modules\.bin\wrangler.cmd'
```

---

## 0. 前置条件

| 项 | 要求 |
|---|---|
| GitHub | 新账号；仓库 `lx-source-watch`，**Public**、**空仓库**（不要 README） |
| GitHub PAT | Fine-grained，仅授权该仓库，`Contents: Read and write` |
| Cloudflare | 新账号；目标域名已托管在同一个账号 |
| 本地 | Node 22+、仓库已 `pnpm install` |

PAT 只放本地文件，不要提交、不要发聊天：

```
C:\Users\Administrator\lx-watch-github-token.txt
```

---

## 1. 登录 Cloudflare

```powershell
cd apps\worker
.\node_modules\.bin\wrangler.cmd login
```

浏览器里用**新账号**登录并 Allow。验证：

```powershell
.\node_modules\.bin\wrangler.cmd whoami
```

应显示账号邮箱与 Account ID。

---

## 2. 创建 KV 与 D1

```powershell
cd apps\worker

# KV：存最新快照，每轮 1 次写
.\node_modules\.bin\wrangler.cmd kv namespace create SNAPSHOT

# D1：存历史/明细/候选
.\node_modules\.bin\wrangler.cmd d1 create lx-source-watch
```

两条命令都会打印一段 JSON（或提示已存在）。把输出的 `id` / `database_id` 回填到 `apps/worker/wrangler.jsonc`：

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

> 注意：D1 的 `database_name` 必须保持 `lx-source-watch`，迁移脚本按这个名字找库。

---

## 3. 远程建表

```powershell
.\node_modules\.bin\wrangler.cmd d1 migrations apply lx-source-watch --remote
```

应看到 `0001_init.sql` 的 15 条命令全部成功。验证：

```powershell
.\node_modules\.bin\wrangler.cmd d1 execute lx-source-watch --remote --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
```

应包含 `candidates / events / platform_daily / platform_results / runs / settings / source_daily / source_runs / sources`。

---

## 4. 设置 Worker 密钥

先生成一个高强度随机串（32 字节 hex，不打印到屏幕）：

```powershell
$bytes = [byte[]]::new(32)
[System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
$secret = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
$secret | Set-Content -NoNewline 'C:\Users\Administrator\lx-watch-ingest-secret.txt'
```

写入 Worker（交互式，粘贴上面输出的值）：

```powershell
.\node_modules\.bin\wrangler.cmd secret put INGEST_SECRET
```

同一个值后面要写进 GitHub 仓库的 Actions secret `INGEST_SECRET`，两处必须一致。

---

## 5. 部署 Worker

```powershell
.\node_modules\.bin\wrangler.cmd deploy
```

记下输出的 `https://lx-source-watch.<account>.workers.dev`。

自检：

```powershell
curl.exe -s https://lx-source-watch.<account>.workers.dev/api/health
```

此刻 `ok=false`、`sources=0` 是正常的——还没有第一轮上报。

### 5.1 自定义域名（可选）

域名在同一 Cloudflare 账号时，在 `wrangler.jsonc` 顶层加：

```jsonc
"routes": [
  { "pattern": "lx.example.com", "custom_domain": true }
]
```

再 `wrangler deploy` 一次即可；证书由 Cloudflare 自动签发。

---

## 6. 推送到 GitHub

首次推送用本地 PAT + askpass，避免把 token 写进 remote URL：

```powershell
cd ..\..
$env:GIT_ASKPASS = 'C:\Users\Administrator\lx-watch-askpass.cmd'
$env:GIT_TERMINAL_PROMPT = '0'
git remote add origin https://github.com/<owner>/lx-source-watch.git
git push -u origin master
```

`lx-watch-askpass.cmd` 内容（只读 token 文件，不打印）：

```bat
@echo off
set /p TOKEN=<C:\Users\Administrator\lx-watch-github-token.txt
echo %TOKEN%
```

推送前确认作者身份是新账号：

```powershell
git config user.name "<新账号用户名>"
git config user.email "<新账号用户名>@users.noreply.github.com"
git commit --amend --reset-author --no-edit
```

---

## 7. 配置 Actions

仓库 Settings → Secrets and variables → Actions → New repository secret：

| Name | Value |
|---|---|
| `INGEST_SECRET` | 第 4 步生成的同一个值 |
| `INGEST_URL` | `https://<你的 Worker 域名>/api/ingest` |

不需要 `CF_API_TOKEN`——部署由本地 wrangler 完成，CI 只负责探测与上报。

手动触发第一轮：Actions → `Probe sources` → Run workflow，`only` 留空、`limit` 可填 `3` 先试。

---

## 8. 验收清单

- [ ] Actions 的 `probe` job 绿；artifact `probe-result` 里有 `status.json` / `urls.json`
- [ ] `publish` job 日志出现 `ingest ok`，无 401
- [ ] `GET /api/status` 返回 19 个源，`stale=false`
- [ ] `GET /api/health` `ok=true`，`lastRun` 非空
- [ ] `GET /api/sources/qingliang` 有 history/daily
- [ ] `GET /api/export?format=csv` 可下载
- [ ] 重复跑同一 workflow 不会产生重复 run（D1 `runs` 行数不翻倍）
- [ ] Cloudflare 控制台 KV 写 ≈ 6 次/天、D1 写 ≈ 2.6k 行/天

---

## 9. 排障

| 现象 | 排查 |
|---|---|
| publish 401 `bad_signature` | Worker 与 GitHub 的 `INGEST_SECRET` 不一致；重设两处 |
| publish `INGEST_URL` 为空被跳过 | 仓库 secret 名写错，或 job 没拿到 environment |
| `/api/status` 503 | KV 还没有 `snapshot:latest`；先跑一轮 probe + ingest |
| `stale=true` | 最近一轮超过 8 小时；看 Actions 是否被停用 |
| Worker 部署报 D1 找不到 | `database_name` 与迁移命令不一致 |
| 域名 522/1016 | DNS 记录冲突；自定义域不要手工加 A 记录 |

---

## 10. 回滚

- Worker：`wrangler deployments list` 找到上一版，`wrangler rollback [deployment-id]`
- 数据：D1 有 14 天明细 / 180 天汇总；误删只能靠 `wrangler d1 export` 的备份（建议每周导出一次）
- 代码：`git revert` 后重新 deploy；探测逻辑在 `apps/runner`，与展示层解耦

## 11. 国内补测（P5，可选）

国内补测通过你自备的 HTTP/SOCKS 代理或 mihomo 内核节点完成，不依赖 Cloudflare 的出口。

### 11.1 新增两个密钥

```powershell
# Worker：供 Actions 的 cn job 拉取代理池（随机 32 字节 hex 即可）
$runnerToken = -join ((1..64) | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) })
pnpm --filter @lx/worker exec wrangler secret put RUNNER_TOKEN
# 粘贴上面的 $runnerToken

# Worker：代理密码/内核配置的加密密钥（32 字节，base64）
$proxyKey = [Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Max 256 }))
pnpm --filter @lx/worker exec wrangler secret put PROXY_ENC_KEY
# 粘贴上面的 $proxyKey
```

GitHub 仓库 Actions secrets 里再加一个 `RUNNER_TOKEN`，值与 Worker 的相同。

### 11.2 建表与导入代理

```powershell
pnpm --filter @lx/worker exec wrangler d1 migrations apply lx-source-watch --remote -y
```

打开 `https://dash.dpdns.org/admin/proxies`，粘贴订阅（Clash YAML / Base64 / 分享链接 / host:port），或手动添加。密码与内核配置会用 AES-GCM 加密存 D1，页面只显示掩码。

### 11.3 补测如何运行

- `probe` job（无密钥）只负责产出 `out/status.json` 与 `out/urls.json`。
- `cn` job 拿 `RUNNER_TOKEN` 拉代理池，挑一个可用节点，对已解析 URL 发 Range 64KB 请求，产出 `out/cn.json`；**不执行任何音源脚本**。
- `publish` job 合并 `out/cn.json` 后一次 HMAC 上报；国内可达只作为独立标记，不改变总状态。
- 没配 `RUNNER_TOKEN` 时 cn job 自动跳过，站点仍可用。
- 内核协议（ss/vmess/vless/trojan/hysteria2/tuic）会让 cn job 下载固定版本 mihomo（v1.19.9）并缓存；单个代理只代表该节点出口，不代表全国各地区。

---

## 12. 音源注册表与自动发现

- 迁移 `0008_source_registry.sql` 会建 `source_registry` 表并写入初始 19 个源；之后以 D1 为唯一清单，`/admin/sources` 可新增、编辑、启停、删除。
- `GET /api/config/sources` 是公开接口，Actions 的 probe job 通过 `LX_REGISTRY_URL` 读取，读不到时自动回退仓库里的 `sources/registry.json`；探测 job 仍然零密钥。
- 每个源支持主地址 + 最多 10 个自定义镜像；加速模板在「管理后台 → 设置 → 加速镜像」里维护，默认 8 条，随时可换。
- 自动发现由 Worker 定时（默认 12 小时）或「候选源 → 立即发现」触发；发现步骤只在该 step 使用仓库自带的 `GITHUB_TOKEN`，不会拿到上报/部署密钥。
- 候选初始化通过后可自动收录为正式源（默认每轮最多 3 个），审核策略在「设置 → 候选与自动收录」里调整。

## 13. 定时与设置

- GitHub 工作流本身不再配置 `schedule`；Worker 的 cron `*/5 * * * *` 每 5 分钟判断是否到点，再通过 GitHub API 派发 probe / proxy-test。
- 探测与测活的间隔、每轮源数、并发、是否 deep、国内补测、自动发现、数据保留天数都在「设置」页里改，存 D1 的 `settings` 表，不需要重新部署。
- 手动触发时间也参与“下次到期”计算；派发失败会记录原因，并在设置页和任务中心显示。
- 额度：工作台顶部显示 KV/D1/Actions 用量；KV 写保护阈值 920/1000，D1 写保护阈值 9 万/10 万。

