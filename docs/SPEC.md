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
| 页面 | 工作台、总览、源详情、候选、重复源、运行列表/详情（含最近事件）、音源管理、设置、国内代理、测活日志、关于、登录 |
| 认证 | 整站登录；PBKDF2-SHA256（≤100000 轮）+ HMAC 会话 Cookie；KV 登录限流 |

## 5. 页面规格

### 5.1 工作台 `/`

- 单列概览页：渐变概览条显示标题、数据状态、上次/下轮/本轮耗时/候选数，右侧「立即探测 / 派发排队 / 刷新」。
- 5 张指标卡：音源总数（含可用/部分/失效）、平台通过、接入点通过、国内可达、候选源。
- 任务中心：正在运行/排队中双栏 → 定时计划横条（探测/发现/测活/国内补测/数据清理，含上次结果、下次时间；探测/发现/测活可立即执行，国内补测按探测后自动触发并可「立即补测」全量运行，数据清理只由调度器自动创建）→「最近任务 / 操作记录 / 计划任务」三 tab。
- 最近任务按行展示：状态徽标、类型、触发、时间、摘要、统计（可用/部分/失效/未测、平台、接入点、国内）、耗时、运行/日志链接；失败明细收进折叠，默认每页 10 条。运行中的任务显示 progress 进度条，queued/paused 任务支持立即执行、暂停、恢复、取消；failed/cancelled 支持重试（partial 不自动重试）。
- 计划任务 tab：真实任务行，列任务/触发/下次运行/上次运行/状态/操作；数据来自 scheduler 状态，首屏未加载显示「加载中…」，探测/发现/测活可立即执行，国内补测可「补测」，数据清理显示自动；移动端 760px 以下转卡片。
- 队列状态与操作：queued → paused → queued（恢复），queued 可立即执行（priority=0）、取消；paused 可取消；retry 只创建新的 queued 任务，保留 `retryOf/retryCount`。
- 任务与 run 对账：running 任务每 5 分钟与 GitHub 最近 run 对账；无 run 超 20 分钟、或 workflow 已结束超 60 秒未回写，自动收口为 failed/成功未回写，避免永久 running。
- 结构化日志：`runs.log_key` 对应 KV 文本日志；`run:<id>:jsonl` 存 JSONL（14 天），运行详情「结构化 / 文本」切换，旧 run 从文本现场转换。
- 操作记录：时间、操作、目标、结果、说明；按“事件”保留天数自动清理，也可在手动清理运行记录时一起清理。
- 数据清理：由调度器每 24 小时最多创建一次「数据清理」任务，写入运行记录和 KV 日志；任务卡显示运行/接入点/日汇总/事件/操作记录删除数，可进运行详情与日志。
- 指标下方：4 张额度卡（KV 写入/读取、D1 写入、Actions 本月）、轮次覆盖条、快捷入口，三者并排放在任务中心上方。

### 5.2 音源总览 `/sources`

- 统计卡：源总数、可用/部分/失效/未测、平台通过/已测、国内可达平台数、最近更新时间。
- 质量范围「推荐 / 可用 / 全部」：推荐按 `assessSourceQuality` 的 `recommended`，可用按 `status=available`，全部不额外过滤；默认全部，参数 `quality` 可分享。
- 默认三列卡片（≤1240 两列、≤760 单列），可切列表；卡片显示标题、版本、状态、来源、四格指标（接入点/平台/国内/耗时）、全部声明平台芯片、问题摘要、本轮主地址或镜像、复制导入地址、详情；推荐源带「推荐」pill。
- 列表视图保留表格，并增加质量列（分数 + 等级）；两种视图的搜索、状态、平台、分类、关键词、只看国内失败、质量范围筛选一致；排序按质量分降序，再按平台通过数、标题。
- 操作：详情、复制导入链接（默认推荐地址，可下拉选择主地址或任一镜像）。
- 国内未测：区分“本轮无失败平台，无需补测”和“有失败平台但本轮未执行补测”。

### 5.3 源详情 `/s/:id`

- 顶部摘要卡：标题、状态、质量分、版本、id/作者/分类、检测时间、来源、本轮入口、描述；右侧导入地址下拉（推荐/主/镜像）、复制、脚本主页。
- 质量解释：Hero 下显示质量等级与推荐状态，并列出扣分/加分原因（初始化失败、过期、国内全失败、平台/接入点通过率等）；公式见 6.6。
- 5 个迷你指标：通过平台、国内可达、接入点、声明平台、本轮耗时。
- 四个 tab：
  - 概览：健康摘要、平台状态 chips、失败平台原因（前 4 条）、镜像落后提示。
  - 平台：3 列平台卡片，显示音质、取链/首字节/总耗时、拉流地址、国内补测、错误（最多 4 行，title 全文）。
  - 接入点：表格显示角色、地址、下载、版本、耗时、国内、错误；长 URL 截断并保留完整 title。
  - 历史：14 天柱图、平台趋势、最近轮次。

### 5.4 候选 `/candidates`

- 单卡片列表：统计卡 + 一条工具栏（搜索/仓库/状态分段）；行内展示仓库路径、平台芯片、初始化/版本/首次发现与收录/拒绝。
- 发现仓库：可添加/停用/删除自定义 GitHub 仓库（`owner/repo`、分支、最多 5 个路径前缀、备注）；支持直接粘贴 `github.com/owner/repo`、`/tree/branch/path`、SSH 或裸 `owner/repo`，解析后预览再保存。内置仓库仍在 `sources/discovery.json`，Actions 启动时读取公开配置并合并，按 `repo@branch` 去重；读取失败只告警并继续内置仓库。
- 发现上限可配：每轮全仓库合计默认 20 个（`discoveryMaxFetchPerRun`，1–120），每仓库默认 5 个（`discoveryMaxFetchPerRepo`，1–40），避免大仓库占满全局名额；仓库列表上限 200，Actions 侧每批 4 个仓库并发取树，保留顺序、上限与失败隔离。候选未做拉流校验，不代表可用。
- 自动转正门槛：初始化成功、声明平台数 ≥ `autoPromoteMinPlatforms`（默认 2，1–8）；可选要求至少一个可测试平台 key（默认开启）；手动收录不受门槛限制。门槛不通过只累加 skipped 并写 warnings，不改候选状态。
- 列表分页默认每页 10 条，可切 20/50/全部。
- 去重：内容 sha256 相同直接并为主源别名；标题和作者相同但 sha256 不同视为“同名多版本”，不自动合并；在重复页可手动停用某个版本（registry 置 disabled，candidate 置 rejected），保留对照记录。
- 备用线路：在音源管理页粘贴第三方托管脚本地址（每行一个，最多 20 个）；自动模式按标题+作者匹配、退回唯一标题匹配，手动模式指定音源。预览后追加为该音源的自定义镜像（每源上限 10），不改变主地址。

### 5.5 运行 `/runs`、`/runs/:runId`

- 列表：四 tab（运行记录 / 平台汇总 / 失败聚合 / 最近事件），按天筛选；运行记录服务端分页，默认每页 10 条，可按状态、触发方式筛选。
- 失败聚合：可按失败原因筛选、按原因/平台/错误文案搜索；失败原因卡和“失败最多的源”分别分页，无匹配时显示空态。
- 最近事件：源恢复、降级、失效、新源与版本变化；懒加载最近 200 条，客户端分页。
- 详情三 tab：概览 / 逐源结果 / 运行日志。
  - 概览：统计卡、失败原因（默认前 8 类，可展开全部）、步骤。
  - 逐源结果：源列表分页，源卡片默认折叠；展开后显示接入点与平台小表。
  - 运行日志：独立 tab，可搜索、只看可疑行，工具栏吸顶，按 200 行分页（200/500/1000/全部）。

### 5.6 管理页

- `/admin/sources`：单卡片列表，行内显示版本、中文状态、来源、接入点/镜像/最近变化；新增/编辑走右侧抽屉；新增支持「在线链接 / 上传 JS」两种模式，上传模式显示文件/名称/分类/主页/备注/保存后立即测试；上传来源行显示「上传」标记与「下载」；备用线路导入折叠在卡片内；列表分页。
- `/admin/proxies`：顶部 3 张统计（节点总数/最近可用/订阅数）、订阅表、批量导入、折叠的手动添加节点、节点表；订阅与节点列表分别分页。
- `/admin/proxy-tests`：测活轮次与逐节点日志、CSV；逐节点结果分页。
- `/admin/settings`：调度、发现扩容（每轮/每仓库上限）、国内补测、测活、自动发现/收录（最少声明平台数、可测试平台要求）、保留天数、加速镜像、清理运行记录、额度护栏、系统信息；三列面板，清理与镜像占满整行，移动端单列；关闭的任务显示“已关闭，未安排下次运行”。
- `/admin`：旧控制面板入口，现重定向到 `/admin/settings`；运行记录、事件已并入 `/runs`，修改密码与危险操作已移除。
- `/admin/duplicates`：统计卡 + 内容重复分组行 + 别名表 + 「同名多版本」表；同名不同 sha 列出 registry/candidate 两类版本与状态，可手动停用，停用前弹确认；合并操作使用行内链接。
- `/about`：6 个说明卡片（怎么看结果/平台 key/检测局限/导入方式/额度与实现/数据与隐私），两列布局，移动端单列。

### 5.7 分页

- 所有长列表（任务、操作记录、运行、候选、重复源、音源、代理、订阅、测活结果、运行详情源列表、运行日志、运行最近事件）默认每页 10 条，可选 20/50/全部；运行日志按 200/500/1000/全部；首页/上一页/下一页/末页与“共 N 条，当前 x–y”保持一致。
- 运行记录由服务端分页（`limit/offset/status/trigger/days/q`）；其余列表在当前页客户端分页；筛选或每页数量变化时回到第一页。
- 760px 以下，运行记录、代理订阅/节点、管理页运行记录等表格转为卡片，每行带字段标签；代理节点隐藏「出口」「最近测活」次要列。全站以 `scripts/ui-audit.mjs` 检查桌面/移动无横向溢出与无控制台错误。

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

`SourceResult`：`id/title/url/mirror/homepage/category/storage/version/author/description/origin/expire/scriptSha/sha256/endpoints/via(primary|mirror)/chosenUrl/status/initOk/initError/stats/platforms/checkedAt/durationMs`。

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
- `tasks/task_locks/task_state`：单并发任务队列、锁、调度的最近时间。`tasks` 含 type/source/status（queued/paused/running/succeeded/partial/failed/cancelled）/priority/payload/progress/message/run_id/github_run_id/retry_count/retry_of/last_heartbeat_at/result；`tasks.result` 存类型化结果摘要（源/平台/接入点、通过/部分/失效的源、通过/失败的平台、订阅统计、警告），超长时安全裁剪数组而不是截断 JSON。单源测试的 result 只统计本次 sourceId，不再复用整轮快照。
- `admin_activity`：后台写操作记录（时间、方法、路径、操作名、目标、状态、说明）。
- `proxy_test_runs/proxy_test_results`：测活轮次与逐节点结果。
- `source_registry/source_aliases`：音源注册表（含 `author`、`origin` 来源仓库/路径）与重复源别名。
- `discovery_repos`：网页添加的自定义发现仓库（repo/branch/path_prefixes/enabled/notes），与内置 `sources/discovery.json` 合并；`(repo, branch)` 唯一。

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
| GET | `/api/config/discovery` | 公开的自定义发现仓库 + 发现上限，供 Actions 合并 |
| GET/POST | `/api/admin/discovery-repos` | 列出/添加自定义发现仓库 |
| POST | `/api/admin/duplicates/versions/disable` | 停用同名多版本中的一个版本（registry disabled / candidate rejected） |
| PATCH/DELETE | `/api/admin/discovery-repos/:id` | 启停/修改/删除自定义发现仓库 |
| POST | `/api/admin/sources/backups/preview` | 解析备用线路地址并匹配音源，不写库 |
| POST | `/api/admin/sources/backups/import` | 把匹配结果追加为音源镜像 |
| POST | `/api/admin/sources/upload` | 上传 `.js` 脚本创建正式源；同 sha 409；可选创建 source-test 任务 |
| GET | `/api/admin/sources/:id/script` | 下载该音源的脚本文件（只读，不建任务） |
| GET | `/scripts/:sha256.js` | 公开的哈希脚本地址；长缓存、CORS `*` |
| GET | `/api/health` | 健康检查 |
| POST | `/api/ingest` | 仅 publish job，HMAC + runId 幂等 |
| POST | `/api/admin/proxies/preview` | 导入预览，只统计不写库 |
| GET | `/api/runner/config` | Actions 读取运行参数（Bearer RUNNER_TOKEN） |
| GET | `/api/runner/cn-input/:probeRunId` | 独立 CN 任务读取探测输入（Bearer） |
| POST | `/api/runner/cn-result` | 独立 CN 任务回传结果并合并快照（Bearer） |
| GET | `/api/runner/proxies` | Actions 拉取代理池（Bearer） |
| POST | `/api/runner/proxy-subscription-result` | Actions 回传订阅拉取结果（Bearer） |
| POST | `/api/admin/runs/purge` | 运行记录清理预览/执行 |
| GET | `/api/admin/snapshots` | 运行记录分页；支持 limit/offset/status/trigger/days/q |
| GET | `/api/admin/tasks` | 任务列表；支持 status（含 finished/queued/paused）/type/source/q/limit/offset |
| POST | `/api/admin/tasks` | 创建任务并按队列派发；长任务统一入口 |
| POST | `/api/admin/tasks/:id/cancel` | 取消 queued/paused/running 任务 |
| POST | `/api/admin/tasks/:id/pause` | queued → paused |
| POST | `/api/admin/tasks/:id/resume` | paused → queued，并尝试派发 |
| POST | `/api/admin/tasks/:id/run-now` | queued 置顶（priority=0）并尝试派发 |
| POST | `/api/admin/tasks/:id/retry` | failed/cancelled 创建重试任务 |
| POST | `/api/admin/tasks/reconcile` | 手动触发 GitHub run 对账 |
| POST | `/api/runner/progress` | Actions task-scoped 进度回写（不暴露业务密钥） |
| GET | `/api/admin/snapshots/:runId/log?format=jsonl` | 结构化日志；旧 run 现场转换 |
| GET | `/api/overview` | 工作台精简快照（sources=[]、endpoints/cn 聚合、CN pending） |
| GET | `/api/admin/activity` | 后台操作记录；支持 limit/offset/ok |

缓存：`/api/status` 允许短缓存；测活详情 `private, max-age=15`；上报不缓存。

### 6.6 质量评分

`assessSourceQuality(source, now)` 是纯函数，客户端与服务端共用，结果不落库；分数用于总览推荐与详情解释。

- 平台分：`50 × 通过平台数 / 已测平台数`（未测按 0）。
- 接入点分：`20 × 下载成功接入点数 / 接入点总数`。
- 覆盖分：`10 × 已测平台数 / 声明平台数`。
- 新鲜度：`checkedAt` 在 26 小时内给 10 分，否则 0。
- 国内分：有 CN 测试则 `5 × 通过数 / 测试数`；完全没有 CN 测试给中性 5 分。
- 初始化失败扣 30 分。
- 等级：`excellent` 需 available 且接入点通过率 ≥0.8；`good` 需平台/接入点通过率 ≥0.6 且已测平台 ≥2；`limited` 需平台通过率 ≥0.3；`untested` 为无已测平台；其余 `poor`。结果不新鲜或 CN 全失败时最高只能 `limited`。
- 推荐：等级为 `excellent` 或 `good`，且初始化成功；同一批源里不做强制去重，同名多版本由 E4 的重复页处理。

### 6.7 任务协议

- 入口：`POST /api/admin/tasks` 创建任务，Worker 单并发 `dispatchNext`；探测/发现/单源/补测/测活/订阅/清理共用队列。
- 派发：`createTask` 对 probe/source-test/discovery/cn-probe/proxy-test 生成 32 位 `progressToken`，仅随对应 workflow 输入下发；`POST /api/runner/progress` 校验 taskId/runId/token/type/status/runId 匹配后更新 progress/message/heartbeat。
- 进度单位：探测按源、发现按仓库/候选、补测按地址、测活按节点；任务卡显示 done/total 与百分比。
- 完成：runner 回传结果时 `completeTaskForRun` 更新最终状态、result、finishedAt；进度 total 保留任务累计值，不固定 1/1。
- 对账：`reconcileTaskRuns` 每 5 分钟检查 running 任务；优先 `github_run_id`，否则取 startedAt-120s 后最早 run；无 run 超 20 分钟 failed，run 已结束超 60 秒未回写则 failed/「成功但未回写」。
- 重试：仅 failed/cancelled 可手动重试；派发 429/502（非令牌/权限/未配置）自动重试最多 2 次；partial 不自动重试。
- 操作记录：所有管理员写操作写 `admin_activity`；同步 CRUD 不建 task，但必须留操作记录。

### 6.8 上传型音源与脚本下载

- 存储：脚本内容存 KV `script:<sha256>`；`source_files(source_id, sha256, filename, bytes, created_at)` 记录归属，同 sha 已存在时复用，不重复写 KV。
- 上传：`POST /api/admin/sources/upload`，仅 `.js`、≤2MB、非 NUL/HTML、≥50 字符；按 sha256 去重；创建 `origin='upload'` 的正式源，公开地址为 `PUBLIC_ORIGIN/scripts/<sha256>.js`。
- 公开：`GET /scripts/:sha256.js`，不可枚举，`cache-control: public, max-age=31536000, immutable`，`access-control-allow-origin: *`。
- 选项：`testAfterSave` 为 true 时创建 `source-test` 任务（走统一队列）；否则只建源。
- 下载：`GET /api/admin/sources/:id/script` 只读，不建任务；返回 attachment，中文文件名用 `filename*=UTF-8''`；来源音源在详情页显示「下载 JS」。
- 删除源时同步删除 `source_files` 记录，KV 内容按 sha 复用/保留。

---

## 7. 检测协议

1. 下载脚本（≤2MB，20s，主地址失败回退镜像），并检查全部接入点。
2. 解析头部元数据（`@name/@version/@author/@description/@homepage/@expire/@support`）。
3. 在 `node:vm` 沙箱初始化（12s），注入 LX 2.0 API；`inited.sources` 为空算初始化失败。
4. 平台列表 = 脚本声明的 `sources` + 元数据 `@support`（未声明为“扩展平台”，标未测）。
5. 每平台最多 2 首测试曲；默认 128k，`--deep` 从最高音质开始，失败回退 128k。
6. 取链：调用 `musicUrl`，20s；返回必须为 http(s) URL。
7. 拉流：Range `bytes=0-2047`，12s，校验魔数/Content-Type，拒绝 JSON/HTML 错误页；HLS 清单接受。
8. 瞬时重试：取链或拉流首次失败若为网络/超时/HTTP 408/429/5xx，且本平台重试预算未用完，600ms 后重试一次；4xx、非音频、空地址、脚本异常、初始化失败不重试。取链与拉流共享每平台一次预算，避免同一平台连续重试拖慢整轮；日志分别记录“将重试 / 重试成功 / 重试仍失败”。
9. 记录 `resolveMs/ttfbMs/totalMs`，失败归类到 6.4。
10. 单源失败不影响整轮；局部复测合并上一轮未测源。
11. 连续 3 轮全平台失败标记“持续失效”。

## 8. 国内补测

国内补测是**独立任务**，不是探测工作流的子步骤：探测上报成功后，Worker 在设置开启时立即创建 `cn-probe` 任务、占位运行，并把本轮全部播放地址写入 KV；再由独立的 `cn-probe.yml` 拉取输入、只做地址 Range 探活、回传结果。任务中心会在「定时计划」显示“国内补测 · 探测后自动”，在「最近任务」与探测共用 7 项摘要和完整失败明细，运行详情有独立日志；没有可补测对象时也留一条已完成任务/运行，记录“没有可补测的播放地址”。工作台该计划项提供「立即补测」，按最近一轮探测输入全量创建任务。

- 地址拉流：本轮全部播放地址按 URL 去重后全部复测，不以海外成败筛选，也不复用历史通过；不设批次上限和时间冷却，写平台国内拉流结果；源接入点（主地址/镜像）另写 `endpoint.cn`。
- 不重跑平台脚本：海外取链失败的平台显示「海外失败，国内未验证」，不把代理脚本重测当成国内直连。
- 补测只改变 `endpoint.cn` / 平台国内拉流结果，不改变音源 `available` 总状态。
- CN 运行预算 45 分钟、workflow 上限 60 分钟；代理不预检全部节点，先按最近成功排序取 12 个并发预检延迟，按延迟优先、最多试 3 个；地址可达率低于 5% 立即换节点。
- 代理池：支持 HTTP/SOCKS、mihomo 内核（ss/vmess/vless/trojan/hysteria2/tuic）；内核节点可用普通节点做 `dialer-proxy` 跳板，失败自动换下一个节点；hy2/tuic 等 UDP 节点标记跳过。
- 订阅：Worker 直连拉取失败 401/403 时返回 `fetch_forbidden` + `needsRunner`，前端引导用 Actions 拉取；订阅支持自定义 headers（禁止 Host/Content-Length/Connection/Transfer-Encoding）。
- 凭据只存 Worker secret 与加密后的 D1；`proxy` 字段只记 host:port。

## 9. 调度与任务

- Worker cron `*/5 * * * *` 每 5 分钟检查一次；到点创建任务并派发对应 GitHub workflow。
- 单并发：同一时间只跑一个任务，其余排队；45 分钟看门狗把超时任务置失败。
- 任务类型：`probe`、`source-test`、`discovery`、`proxy-test`、`proxy-fetch-sub`、`cn-probe`、`retention`；任务结果写 `tasks.result`，含摘要、计数、失败源/失败平台/通过源、按订阅统计、警告。CN 任务与探测使用同一套源/平台数组。
- 调度器只固定调度探测/发现/测活；国内补测不按固定间隔跑，而是每次探测上报成功后立即由钩子创建 `cn-probe` 任务（无时间冷却；无地址也留已完成任务与运行）。
- 手动触发时间参与下次到期计算；派发失败写入 runs/tasks 并在工作台显示。
- 额度达到护栏阈值时暂停派发，恢复后继续。
- 调度器每次运行顺带检查保留策略：距上次清理满 24 小时才创建一个 `retention` 任务，写入运行记录与 `run:<id>:log` 日志；明细按 `retentionDetailDays` 删除旧运行及其接入点/平台/任务，日汇总按 `retentionDailyDays`、事件与操作记录按 `retentionEventDays` 删除；清理失败只告警，不影响任务派发，任务中心仍能看到失败状态与错误。

## 10. 存储与额度

| 资源 | 用法 |
|---|---|
| KV `SNAPSHOT` | 每轮 1 次 `snapshot:latest` 写；运行日志短 TTL |
| D1 | 运行/逐源/逐接入点/平台/日汇总/任务/代理/订阅/候选/注册表/设置 |
| Actions | 公开仓库免费；单轮探测约 1–2 分钟，测活约 3 分钟 |
| R2 | 未使用 |

默认保留：明细 14 天、日汇总 180 天、事件 180 天；可在设置页改。调度器每天最多自动清理一次；设置页「清理运行记录」仍保留手动预览/清理入口，按相同天数删除，永远保留最新一轮探测与测活。

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
- 迁移：`0001`–`0021`，新增迁移必须同时更新部署手册。

## 13. 阶段验收

| 阶段 | 状态 | 验收要点 |
|---|---|---|
| P0–P5 | 已完成 | 探测、Actions 双平面、Worker/KV/D1、页面、代理与国内补测 |
| 阶段 4A–4F | 已完成并上线 | 测活任务化/回调、接入点国内检查、国内展示与筛选、403 兜底、导入预览与运行参数、全链路回归 |
| 阶段 5 | 已完成并上线 | 额度护栏可配置、运行记录预览清理、保留最新一轮 |
| 阶段 6A | 已上线（2026-11-25） | 多仓库发现、每仓库抓取上限、候选按仓库筛选 |
| 阶段 6B | 已完成 | README/SPEC/DEPLOY/CN 评审文档与代码一致 |
| 阶段 6C | 已完成 | 全量本地校验、文档链接/命令核对、线上健康核对 |
| 自定义仓库/备用线路 | 已上线（2026-11-25） | 网页添加发现仓库、Actions 合并；第三方脚本按标题/作者或手动指定导入为镜像 |
| 界面审计与收尾 | 已完成（2026-11-26） | 移动端表格转卡片、正式 404、失败原因筛选、日志工具栏吸顶、自动保留清理、Playwright 持久化回归 |
| A 导航与设置归并 | 已完成（2026-11-26） | 四组导航、删控制面板、事件并入运行与日志、镜像/清理移入设置、操作记录可读 |
| B 国内补测独立任务 | 已完成（2026-11-27 更新） | 探测完成钩子立即创建 cn-probe 任务、全部播放地址每轮复测、无时间冷却、无 200 上限、KV 输入、独立 workflow/运行/日志、与探测共用的 7 项摘要/失败明细、无地址也留可见任务 |
| C 详情与接入点体验 | 已完成并上线（2026-11-26） | 错误中文化、四卡接入点摘要、单条复制、导入地址完整状态、移动端布局 |
| D GitHub 链接导入 | 已完成并上线（2026-11-26） | 候选页粘贴 URL/tree/SSH/裸 owner/repo，解析后预览再保存 |
| E1 质量评分与推荐 | 已完成并上线（2026-11-27） | shared 评分、总览推荐/可用/全部筛选与排序、卡片推荐标记、详情解释 |
| E2 瞬时失败重试 | 已完成并上线（2026-11-27） | 网络/超时/408/429/5xx 每平台重试一次，600ms；4xx/非音频/脚本异常不重试 |
| E3 自动收录门槛 | 已完成并上线（2026-11-27） | initOk + 最少声明平台数 + 可选可测试平台要求，可配置；手动收录绕过 |
| E4 同名多版本治理 | 已完成并上线（2026-11-27） | 同名不同 sha 不自动合并，列表展示与手动停用，保留版本对照 |
| E5 发现扩容 | 已完成并上线（2026-11-27） | 每轮/每仓库上限可配，仓库上限 200，Actions 每批 4 仓库并发取树 |
| 任务中心 1:1 | 已完成并上线（2026-11-28） | 全入口任务化、task→run→progress→log、暂停/恢复/立即执行/取消/重试、run 对账、计划任务真实行、JSONL 日志、移动端卡片 |

## 14. 已知边界

- 云端 Actions 在海外，国内平台/接入点结果与用户本地网络可能不同；国内列只代表所选代理出口。
- 真实机场订阅 403 的 Actions 全链路尚未用真实订阅验证；已用 httpbin 403 验证识别与提示。
- 内核节点只能在 Linux Actions 验证；Windows 本地无法运行 mihomo。
- 少数内核节点因域名失效、仅 IPv6、跨境 80 端口受限而不可用；`CN-山东电信` 已软停用。
- 定时任务已开启：探测每 4 小时、自动发现每 12 小时、代理测活每 6 小时；如额度紧张可在设置页关闭。
- E5 扩容目前只在 6 个内置仓库上观察过：同秒开始、约 1.3 秒完成、21 个候选、无 403；几十个仓库或超大仓库的 GitHub 限流/耗时仍未压测。
- 重试日志已记录“将重试 / 重试成功 / 重试仍失败”，但“救回率”仍建议结合最终平台结果判断；重试不改变原始错误分类。
- `source_registry` 没有版本列，E4「同名多版本」里正式源版本显示 `—`，候选才有版本；后续如要按版本比较，需要补迁移。
- 自动收录门槛只做本地判断，不访问网络；候选的真实可用性仍以收录后的首轮探测为准。
