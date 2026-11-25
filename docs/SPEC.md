# lx-source-watch 规格说明（v1.0）

> 本文描述当前已实现的产品与数据契约，随代码一起维护。历史 P0 草案中的“不做登录/后台”等假设已被取代。

## 1. 一句话

自用的 LX Music 音源可用性监测站：GitHub Actions 在沙箱里运行音源脚本，逐平台取链并校验音频；Cloudflare Worker 托管最新快照与历史，提供整站登录的看板与代理/发现/任务管理；国内可达性单独标记，不改变海外探测结论。

## 2. 目标与非目标

### 目标

- 一眼看出每个音源在酷狗/酷我/QQ 音乐/网易云/咪咕/汽水/B 站等平台的可用性、延迟、失败原因。
- 给出“通过平台数 / 已测平台数”和“国内可达平台数 / 已测平台数”。
- 保留逐轮明细、逐源/接入点/平台三级详情、平台汇总与失败聚合。
- 每条源可直接复制 LX Music 导入链接；支持主地址、自定义镜像与加速模板。
- 国内网络可达性单独一列，使用自备代理或 mihomo 内核节点补测。
- 全部跑在 GitHub Actions + Cloudflare 免费额度内；有额度护栏和运行记录清理。

### 非目标

- 不做音乐搜索、播放、下载、破解付费内容。
- 不托管版权音频；只校验 URL 返回的是不是音频。
- 不承诺 100% 准确：云端网络与用户客户端不同，平台风控会导致误判，页面必须写明。
- 不做多用户体系；当前是单管理员密码 + 整站会话。

## 3. 用户路径

1. 打开看板，用管理员密码登录。
2. 工作台看额度、任务、最近运行；进入音源总览看平台矩阵。
3. 按平台/状态/分类/关键词/国内失败筛选，点进某个源。
4. 看每个平台的状态、延迟、音质、失败原因、国内补测、最近历史。
5. 复制导入链接，在 LX Music 桌面/移动端“自定义源 → 导入”粘贴。
6. 如果自己用时失败，回到详情页看云端结果与失败原因，或到运行详情看接入点/平台级证据。

## 4. 范围

| 项 | 当前实现 |
|---|---|
| 来源 | D1 音源注册表（初始 19 个）+ 管理页 CRUD + GitHub 自动发现候选 + 手动收录 |
| 播放器 | LX Music 桌面 + 移动（官方 kw/kg/tx/wy/mg/local）；扩展平台标注未测 |
| 国内补测 | 自备 HTTP/SOCKS 代理或 mihomo 内核节点；平台与接入点分别标记 |
| 托管 | 只托管维护者主动放入 `sources/local/` 的 `.js`；自动发现只存链接 |
| 频率 | 默认探测 4h、测活 6h、发现 12h；可在设置页改，也可手动触发 |
| 页面 | 工作台、总览、源详情、候选、重复源、运行列表/详情、音源管理、设置、国内代理、测活日志、关于、登录 |
| 认证 | 整站登录；PBKDF2-SHA256（≤100000 轮）+ HMAC 会话 Cookie；KV 登录限流 |

## 5. 页面规格

### 5.1 工作台 `/`

- 额度卡片：KV 写、D1 写、Actions 运行次数与阈值。
- 任务中心：正在运行、排队中、最近任务、操作记录四区；最近任务按类型筛选并显示结果摘要、失败源/失败平台/订阅统计，默认每页 10 条（10/20/50/全部）。
- 所有后台写操作记录到操作记录（时间、操作、目标、成功/失败、说明）。
- 可手动触发探测、测活、发现；顶部额度卡片与定时计划。

### 5.2 音源总览 `/sources`

- 统计卡：源总数、可用/部分/失效/未测、平台通过/已测、国内可达平台数、最近更新时间。
- 源行：名称、分类、版本、作者、状态、通过数/已测数、国内可达数、接入点数、最近检测时间、镜像落后标记。
- 筛选：平台、状态、分类、关键词、只看国内失败；平台矩阵每格显示状态与延迟，悬浮显示失败原因。
- 操作：详情、复制导入链接（默认推荐地址，可下拉选择主地址或任一镜像）。
- 国内可达卡：未测时提示“海外全通过的平台不再补测，未测不等于不可用”。

### 5.3 源详情 `/s/:id`

- 元数据：名称、版本、作者、描述、主页、脚本地址、镜像、脚本 SHA、大小、分类、托管方式。
- 平台表：平台、状态、音质、取链耗时、首字节、总耗时、HTTP 状态、content-type、URL host、失败原因、国内可达。
- 接入点表：主/镜像、下载状态、sha、版本状态（同版本/落后/未知）、耗时、国内可达。
- 历史与日汇总；复制导入链接（默认推荐地址，可切换主地址/镜像）、原始地址、脚本主页。

### 5.4 候选 `/candidates`

- 列表：仓库、路径、标题、版本、平台、大小、初始化结果、首次/最近发现、状态（新/合格/拒绝/已转正/重复）。
- 按仓库筛选；每仓库每轮默认最多取 5 个（`maxFetchPerRepo`），避免大仓库占满全局名额；说明候选未做拉流校验，不代表可用；支持手动/自动转正。
- 去重：内容 sha256 相同直接并为主源别名；标题和作者相同但 sha256 不同视为“相似”，自动转正会跳过并留在合格状态，需人工确认；手动收录可强制。注册表保存作者用于精确匹配。

### 5.5 运行 `/runs`、`/runs/:runId`

- 列表：三 tab（运行记录 / 平台汇总 / 失败聚合），按天筛选。
- 详情三级：源（版本/sha/接入点）→ 接入点（主/镜像、同步状态、耗时、错误、国内）→ 平台（音质、三段耗时、国内、错误）。
- 内嵌日志：可搜索、只看可疑行；运行状态、触发方式、任务、错误、计数。

### 5.6 管理页

- `/admin/sources`：音源注册表 CRUD、启停、镜像/加速模板、导入链接。
- `/admin/proxies`：订阅与节点、导入预览/去重、刷新、用 Actions 拉取、独立测活、测活结果与地区。
- `/admin/proxy-tests`：测活轮次与逐节点日志、CSV。
- `/admin/settings`：调度、国内补测、测活、自动发现/收录、保留天数、额度护栏、加速镜像、系统信息。
- `/admin`：运行记录管理，含“清理运行记录”预览/执行（按天数，永远保留最新一轮）。
- `/admin/duplicates`：sha 重复源与别名合并。
- `/about`：检测口径、额度、免责声明、导入教程。

## 6. 数据契约

### 6.1 快照 `Snapshot v1`

| 字段 | 类型 | 说明 |
|---|---|---|
| `schemaVersion` | `1` | 固定 |
| `runId` | string | 每轮唯一，幂等键 |
| `generatedAt` / `nextCheckAt` | ISO | 生成/下一轮时间 |
| `intervalHours` | number | 当前探测间隔 |
| `runner` | `github-actions`/`local`/`manual` | 执行者 |
| `checkScope` | `all`/`partial` | 全量/局部 |
| `durationMs` | number | 总耗时 |
| `summary` | object | total/available/partial/unavailable/untested/platformsOk/platformsTested |
| `sources[]` | array | 每个源的结果 |

`SourceResult`：`id/title/url/mirror/homepage/category/storage/version/author/description/expire/scriptSha/sha256/endpoints/status/initOk/initError/stats/platforms/checkedAt/durationMs`。

`EndpointResult`：`url/role(primary|candidate)/ok/status/sha/sha256/bytes/version/versionState(synced|lagging|unknown)/ms/error/cn/checkedAt`。

`PlatformResult`：`key/name/declared/tested/ok/quality/resolveMs/ttfbMs/totalMs/errorKind/error/urlHost/httpStatus/contentType/cn`。

`CnResult`：`tested/ok/ms/ttfbMs/errorKind/error/httpStatus/proxy`（`proxy` 只存 host:port，不含凭据）。

`stats`：`{ ok, tested, total }`。

### 6.2 运行与任务

- `runs`：runId、任务 id、触发方式、状态、起止时间、消息/错误、日志 key、steps、计数（接入点/国内/候选/代理）。
- `source_runs`：逐源版本/sha/状态/耗时。
- `endpointRows`：逐接入点下载结果与 cn。
- `platform_results`：逐平台结果。
- `source_daily/platform_daily`：日汇总，供趋势图。
- `tasks/task_locks/task_state`：单并发任务队列、锁、调度的最近时间；`tasks.result` 存类型化结果摘要（源/平台/接入点、失败源、失败平台、订阅统计、警告）。
- `admin_activity`：后台写操作记录（时间、方法、路径、操作名、目标、状态、说明）。
- `proxy_test_runs/proxy_test_results`：测活轮次与逐节点结果。
- `source_registry/source_aliases`：音源注册表与重复源别名。

### 6.3 状态规则

- `tested = 0` → `untested`
- `ok = 0` → `unavailable`
- `ok = tested` → `available`
- 其余 → `partial`

“持续失效”不是另一种状态，而是 `unavailable` + `streak >= 3`。国内结果独立，不参与上述判定。

### 6.4 错误分类

`init`、`script`、`resolve_http`、`resolve_network`、`resolve_timeout`、`resolve_empty`、`stream_http`、`stream_non_audio`、`stream_network`、`stream_timeout`、`unsupported`、`untested`。

### 6.5 主要 API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/status` | 最新快照；支持 platform/status/q/cn 过滤 |
| GET | `/api/sources/:id` | 源详情 + 历史 + 日汇总 |
| GET | `/api/history?days=14` | 轮次列表 |
| GET | `/api/events?limit=50` | 恢复/降级/失效/新增事件 |
| GET | `/api/candidates` | 候选列表；支持 state/limit；按仓库筛选在前端完成 |
| GET | `/api/export` | 导入清单（json/csv） |
| GET | `/api/config/sources` | 公开的注册表，供 Actions 读取 |
| GET | `/api/health` | 健康检查 |
| POST | `/api/ingest` | 仅 publish job，HMAC + runId 幂等 |
| POST | `/api/admin/proxies/preview` | 导入预览，只统计不写库 |
| GET | `/api/runner/config` | Actions 读取运行参数（Bearer RUNNER_TOKEN） |
| GET | `/api/runner/proxies` | Actions 拉取代理池（Bearer） |
| POST | `/api/runner/proxy-subscription-result` | Actions 回传订阅拉取结果（Bearer） |
| POST | `/api/admin/runs/purge` | 运行记录清理预览/执行 |
| GET | `/api/admin/tasks` | 任务列表；支持 status（含 finished）/type/source/q/limit/offset |
| GET | `/api/admin/activity` | 后台操作记录；支持 limit/offset/ok |

缓存：`/api/status` 允许短缓存；测活详情 `private, max-age=15`；上报不缓存。

## 7. 检测协议

1. 下载脚本（≤2MB，20s，主地址失败回退镜像），并检查全部接入点。
2. 解析头部元数据（`@name/@version/@author/@description/@homepage/@expire/@support`）。
3. 在 `node:vm` 沙箱初始化（12s），注入 LX 2.0 API；`inited.sources` 为空算初始化失败。
4. 平台列表 = 脚本声明的 `sources` + 元数据 `@support`（未声明为“扩展平台”，标未测）。
5. 每平台最多 2 首测试曲；默认 128k，`--deep` 从最高音质开始，失败回退 128k。
6. 取链：调用 `musicUrl`，20s；返回必须为 http(s) URL。
7. 拉流：Range `bytes=0-2047`，12s，校验魔数/Content-Type，拒绝 JSON/HTML 错误页；HLS 清单接受。
8. 记录 `resolveMs/ttfbMs/totalMs`，失败归类到 6.4。
9. 单源失败不影响整轮；局部复测合并上一轮未测源。
10. 连续 3 轮全平台失败标记“持续失效”。

## 8. 国内补测

- 平台补测：只测主检测已解析出的 URL，默认只测海外失败/未测项；通过代理发 Range 请求，独立写 `platform.cn`。
- 接入点补测：对每个源的主地址与镜像做 Range 请求，写 `endpoint.cn`；与脚本下载是否成功无关。
- 代理池：支持 HTTP/SOCKS、mihomo 内核（ss/vmess/vless/trojan/hysteria2/tuic）；内核节点可用普通节点做 `dialer-proxy` 跳板，失败自动换下一个节点；hy2/tuic 等 UDP 节点标记跳过。
- 订阅：Worker 直连拉取失败 401/403 时返回 `fetch_forbidden` + `needsRunner`，前端引导用 Actions 拉取；订阅支持自定义 headers（禁止 Host/Content-Length/Connection/Transfer-Encoding）。
- 凭据只存 Worker secret 与加密后的 D1；`proxy` 字段只记 host:port。

## 9. 调度与任务

- Worker cron `*/5 * * * *` 每 5 分钟检查一次；到点创建任务并派发对应 GitHub workflow。
- 单并发：同一时间只跑一个任务，其余排队；45 分钟看门狗把超时任务置失败。
- 任务类型：`probe`、`source-test`、`discovery`、`proxy-test`、`proxy-fetch-sub`；任务结果写 `tasks.result`，含摘要、计数、失败源/失败平台、按订阅统计、警告。
- 手动触发时间参与下次到期计算；派发失败写入 runs/tasks 并在工作台显示。
- 额度达到护栏阈值时暂停派发，恢复后继续。

## 10. 存储与额度

| 资源 | 用法 |
|---|---|
| KV `SNAPSHOT` | 每轮 1 次 `snapshot:latest` 写；运行日志短 TTL |
| D1 | 运行/逐源/逐接入点/平台/日汇总/任务/代理/订阅/候选/注册表/设置 |
| Actions | 公开仓库免费；单轮探测约 1–2 分钟，测活约 3 分钟 |
| R2 | 未使用 |

默认保留：明细 14 天、日汇总 180 天、事件 180 天；可在设置页改。清理入口在 `/admin`，按天数预览后删除，永远保留最新一轮探测与测活。

## 11. 安全边界

- probe job：不注入任何 Cloudflare/GitHub 写权限 secret，`persist-credentials: false`。
- publish job：只读 artifact，做 JSON 校验 + HMAC 签名，绝不执行音源代码。
- `vm` 不是安全边界：靠“无密钥 + 2MB 上限 + 双超时 + 私网拦截 + job 超时”控制风险。
- Worker：HMAC 校验、时间戳窗口、请求体大小上限、登录限流、会话 HMAC、Bearer RUNNER_TOKEN 分离。
- 自动发现只保存候选链接，不复制、不再分发第三方脚本。

## 12. 部署与环境

- 仓库：公开，MIT。
- Cloudflare：Worker + KV + D1 + 自定义域；详见 `docs/DEPLOY.md`。
- GitHub Actions secrets：`CF_API_TOKEN`、`INGEST_SECRET`、`INGEST_URL`、`RUNNER_TOKEN`。
- Worker secrets：`INGEST_SECRET`、`RUNNER_TOKEN`、`PROXY_ENC_KEY`、`CF_ANALYTICS_TOKEN`、`GH_DISPATCH_TOKEN`、`ADMIN_PASSWORD_HASH`、`SESSION_SECRET`。
- 迁移：`0001`–`0019`，新增迁移必须同时更新部署手册。

## 13. 阶段验收

| 阶段 | 状态 | 验收要点 |
|---|---|---|
| P0–P5 | 已完成 | 探测、Actions 双平面、Worker/KV/D1、页面、代理与国内补测 |
| 阶段 4A–4F | 已完成并上线 | 测活任务化/回调、接入点国内检查、国内展示与筛选、403 兜底、导入预览与运行参数、全链路回归 |
| 阶段 5 | 已完成并上线 | 额度护栏可配置、运行记录预览清理、保留最新一轮 |
| 阶段 6A | 已上线（2026-11-25） | 多仓库发现、每仓库抓取上限、候选按仓库筛选 |
| 阶段 6B | 已完成 | README/SPEC/DEPLOY/CN 评审文档与代码一致 |
| 阶段 6C | 待做 | 全量本地校验、文档链接/命令核对、线上健康核对 |

## 14. 已知边界

- 云端 Actions 在海外，国内平台/接入点结果与用户本地网络可能不同；国内列只代表所选代理出口。
- 真实机场订阅 403 的 Actions 全链路尚未用真实订阅验证；已用 httpbin 403 验证识别与提示。
- 内核节点只能在 Linux Actions 验证；Windows 本地无法运行 mihomo。
- 少数内核节点因域名失效、仅 IPv6、跨境 80 端口受限而不可用；`CN-山东电信` 已软停用。
- 代码默认开启定时任务；当前线上为手动触发（三个定时任务关闭），开启前先确认额度与运行时长。
