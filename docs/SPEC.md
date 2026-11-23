# lx-source-watch 规格说明（P0 草案 v0.1）

> 状态：待确认。确认后本文件冻结为 v1.0，后续变更走 PR。
> 本文只描述“做什么、做到什么程度、怎么验收”，不包含实现细节。

## 1. 一句话

公开的 LX Music 音源可用性监测站：GitHub Actions 每 4 小时在沙箱里运行音源脚本，逐平台取链并校验音频，Cloudflare 托管快照与看板，用户一键复制导入链接。

## 2. 目标与非目标

### 目标

- 一眼看出每个音源在 酷狗/酷我/QQ音乐/网易云/咪咕/汽水/B站 等平台的可用性、延迟、失败原因。
- 给出“通过平台数 / 已测平台数”，并保留最近 14 天逐轮历史与 180 天日汇总。
- 每条源可直接复制 LX Music 导入链接，桌面端与移动端都能用。
- 国内网络可达性单独一列，不和海外 Actions 结果混为一个“可用”。
- 全部跑在 GitHub Actions + Cloudflare 免费额度内，长期可持续。

### 非目标

- 不做音乐搜索、播放、下载、破解付费内容。
- 不托管版权音频；只校验 URL 返回的是不是音频。
- 不承诺 100% 准确：云端网络与用户客户端不同，平台风控会导致误判，页面必须写明。
- 不做多用户、登录、后台管理（第一版）。

## 3. 用户路径

1. 打开看板首页，看到所有源的平台矩阵。
2. 按平台/状态/分类筛选，点进某个源。
3. 看该源每个平台的状态、延迟、音质、失败原因、最近历史。
4. 点“复制导入链接”，在 LX Music 桌面/移动端“自定义源 → 导入”粘贴。
5. 如果自己用时失败，回到详情页看是否云端也失败、失败原因是什么。

## 4. 范围（已确认）

| 项 | 决定 |
|---|---|
| 来源 | 固定清单 + PR 提交 + GitHub 自动发现候选，三者都要 |
| 播放器 | LX Music 桌面 + 移动（官方 kw/kg/tx/wy/mg/local）；扩展平台明确标注 |
| 国内补测 | 用户自备 HTTP/SOCKS 代理，独立列展示 |
| 托管 | 只托管用户主动放入 `sources/local/` 的 `.js`；自动发现只存链接 |
| 频率 | 每 4 小时一轮；支持手动 `workflow_dispatch` |
| 页面 | 总览、源详情、候选、关于（4 页） |

## 5. 页面规格

### 5.1 总览 `/`

- 顶部统计卡：源总数、可用、部分可用、失效、未测、平台通过/已测、最近更新时间、下一轮时间。
- 源卡片列表，每张卡：
  - 名称、分类、版本、作者、脚本大小、最近检测时间。
  - 平台矩阵：每个平台一个格子，显示状态色 + 延迟（ms）+ 失败原因摘要（悬浮/展开）。
  - “通过 4/6” + 状态徽章（可用/部分/失效/未测）。
  - 操作：详情、复制导入链接。
- 筛选：平台（多选）、状态、分类、关键词。
- 排序：默认“通过数降序 + 名称”，可切最近更新、延迟。
- 空态/旧数据提示：超过 8 小时未更新显示“数据可能过期”。

### 5.2 源详情 `/s/:id`

- 元数据：名称、版本、作者、描述、主页、脚本地址、镜像、脚本 SHA、大小、分类、托管方式。
- 平台明细表：平台、状态、音质、取链耗时、首字节、总耗时、HTTP 状态、content-type、URL host、失败原因、国内可达。
- 历史：最近 42 轮（约 7 天）每轮状态/通过数/耗时，折线或热力条。
- 日汇总：最近 180 天可用率趋势。
- 操作：复制导入链接、复制原始脚本地址、返回列表。

### 5.3 候选 `/candidates`

- 自动发现列表：仓库、路径、标题、版本、平台、大小、初始化结果、首次/最近发现时间、状态（新/合格/拒绝/已转正）。
- 说明如何转正：提 PR 到 `sources/registry.json`，或由维护者手动加入。
- 明确标注“候选未经过拉流校验，不代表可用”。

### 5.4 关于 `/about`

- 检测原理与口径（初始化/取链/拉流三段、音质、超时、错误分类）。
- 为什么云端结果和本地不同（网络、风控、会员、地区）。
- 额度说明（KV/D1 免费额度、每轮写入量）。
- 免责声明、版权与 takedown 联系方式。
- 导入教程（桌面/移动）。

## 6. 数据契约

### 6.1 快照 `Snapshot v1`

| 字段 | 类型 | 说明 |
|---|---|---|
| `schemaVersion` | `1` | 固定 |
| `runId` | string | 每轮唯一 |
| `generatedAt` | ISO | 生成时间 |
| `nextCheckAt` | ISO | 下一轮预计 |
| `intervalHours` | number | 4 |
| `runner` | `github-actions`/`local`/`manual` | 执行者 |
| `checkScope` | `all`/`partial` | 全量或局部复测 |
| `durationMs` | number | 总耗时 |
| `summary` | object | total/available/partial/unavailable/untested/platformsOk/platformsTested |
| `sources[]` | array | 每个源的结果 |

`SourceResult`：`id/title/url/mirror/homepage/category/storage/version/author/description/expire/scriptSha/status/initOk/initError/stats/platforms/checkedAt/durationMs`。

`PlatformResult`：`key/name/declared/tested/ok/quality/resolveMs/ttfbMs/totalMs/errorKind/error/urlHost/httpStatus/contentType/cn`。

`stats`：`{ ok, tested, total }`。

### 6.2 状态规则

- `tested = 0` → `untested`
- `ok = 0` → `unavailable`
- `ok = tested` → `available`
- 其余 → `partial`

“持续失效”不是另一种状态，而是 `unavailable` + `streak >= 3`，页面上加标记。

### 6.3 错误分类

`init`（初始化）、`script`（脚本抛错）、`resolve_http`（取链 HTTP 错误）、`resolve_network`（取链网络错误）、`resolve_timeout`（取链超时）、`resolve_empty`（没返回地址）、`stream_http`（拉流 HTTP 错误）、`stream_non_audio`（不是音频）、`stream_network`（拉流网络错误）、`stream_timeout`（拉流超时）、`unsupported`（扩展平台未支持）、`untested`（无测试曲/未测）。

### 6.4 公开 API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/status` | 最新快照 + serverTime + stale；支持 platform/status/q 过滤 |
| GET | `/api/sources/:id` | 源详情 + 最近历史 + 日汇总 + 平台日汇总 |
| GET | `/api/history?days=14` | 轮次列表 |
| GET | `/api/events?limit=50` | 最近恢复/降级/失效/新增事件 |
| GET | `/api/candidates?state=new&limit=100` | 自动发现候选列表（按 last_seen 倒序） |
| GET | `/api/export?format=json` | 全部源或筛选结果的导入清单 |
| GET | `/api/health` | 健康检查 |
| POST | `/api/ingest` | 仅 publish job，HMAC 校验 |

缓存：`/api/status` `max-age=30, s-maxage=60`；详情 `max-age=60`；上报不缓存。

## 7. 检测协议

1. 下载脚本（≤2MB，20s，主地址失败回退镜像）。
2. 解析头部元数据（`@name/@version/@author/@description/@homepage/@expire/@support`）。
3. 在 `node:vm` 沙箱初始化（12s），注入 LX 2.0 API；`inited.sources` 为空算初始化失败。
4. 平台列表 = 脚本声明的 `sources` + 元数据 `@support`（未声明为“扩展平台”，标未测）。
5. 每平台最多 2 首测试曲；默认 128k，`--deep` 从最高音质开始，失败回退 128k。
6. 取链：调用 `musicUrl`，20s；返回必须为 http(s) URL。
7. 拉流：Range `bytes=0-2047`，12s，校验魔数/Content-Type，拒绝 JSON/HTML 错误页；HLS 清单接受。
8. 记录 `resolveMs/ttfbMs/totalMs`，失败归类到 6.3。
9. 单源失败不影响整轮；局部复测合并上一轮未测源。
10. 连续 3 轮全平台失败标记“持续失效”。

## 8. 国内补测

- 方式 A（默认）：只测主检测已解析出的 URL，不执行脚本，代理凭据不会暴露给第三方脚本。
- 方式 B（可选，`--execute`）：走代理重新执行脚本，仅对 `trusted=true` 的来源开放；需专用代理账号。
- 结果存 `cn` 字段，页面单独一列；没有代理时显示“国内未测”，绝不把海外结果当国内可用。
- 代理支持 HTTP/HTTPS/SOCKS4/SOCKS5；凭据只放 GitHub Secret（`CN_PROXY_URL`）。

## 9. 存储与额度预算

| 资源 | 用量 | 免费额度 | 占比 |
|---|---|---|---|
| KV 写 | 6 次/天（每轮 1 次 `snapshot:latest`） | 1,000/天 | 0.6% |
| KV 读 | 页面/API 缓存后约数百/天 | 100,000/天 | <1% |
| D1 写 | 约 450 行/轮 × 6 = 2,700/天 | 100,000/天 | 2.7% |
| D1 读 | 详情/历史查询，按需 | 5,000,000/天 | 远低于 |
| R2（可选） | 约 0.9MB/天原始快照 | 10GB | 忽略 |
| Actions | 约 48 分钟/天 | 公开仓库免费 | — |

保留：明细 14 天，日汇总 180 天。

## 10. 安全边界

- probe job：不注入任何 Cloudflare/GitHub 写权限 secret，`persist-credentials: false`。
- publish job：只读 artifact，做 JSON 校验 + HMAC 签名，绝不 `eval`/执行音源代码。
- `vm` 不是安全边界：靠“无密钥 + 2MB 上限 + 双超时 + 私网拦截 + job 20 分钟超时”控制风险。
- Worker：HMAC 校验、时间戳窗口、请求体大小上限、速率限制、CORS 白名单。
- 托管策略：只托管用户主动放入的脚本；收到投诉立即下架；README 放免责声明。

## 11. 部署与环境

- 仓库：公开，MIT。
- Cloudflare：Pages/Workers + KV + D1（+ 可选 R2）。
- GitHub Secrets：`CF_API_TOKEN`、`CF_ACCOUNT_ID`、`CF_KV_NAMESPACE_ID`、`CF_D1_DATABASE_ID`、`INGEST_SECRET`；可选 `CN_PROXY_URL`、`GITHUB_TOKEN`。
- Worker Secrets：`INGEST_SECRET`；Vars：`SITE_NAME`、`PUBLIC_ORIGIN`。
- 自定义域名：`lx.example.com`（待定）。

## 12. 阶段验收

| 阶段 | 交付 | 验收标准 |
|---|---|---|
| P0 | 本规格 | 你确认签字 |
| P1 | 本地 `pnpm probe` 产出快照 | 11 源全跑完；单源失败不中断；抽查 3 个源结果可信 |
| P2 | Actions 双 job | 手动触发成功；坏源不影响整轮；密钥隔离检查通过 |
| P3 | Worker + KV/D1 + API | 每个端点 curl 通过；重复上报幂等；额度占比符合预算 |
| P4 | 4 个页面 | 桌面/手机可用；首屏 <2s；空/旧/错数据有提示 |
| P5 | 国内补测 | 配代理出国内列；没配显示未测；不合并海外结果 |
| P6 | 自动发现 + 候选页 | 跑一次有候选；拒绝不重复；转正流程可走通 |
| P7 | 测试 + 文档 + 首次上线 | 新环境按文档 30 分钟跑通 |

## 13. 待定项（需要你拍板）

1. 仓库名与域名（影响 raw 链接、导入链接、CORS）。
2. 国内代理类型与是否需要账号密码；`CN_PROXY_URL` 放 GitHub Secret 是否接受。
3. 已写的 runner 代码：继续用，还是推倒重写（我的建议：继续用，架构与本文一致）。
4. 是否接受“扩展平台（汽水/B站/QQ SVIP）只展示、不承诺可用”。
5. 品牌名/看板标题（默认 `LX 音源监测`）。

## 14. 里程碑与预算

- P0–P7 约 9–12 个工作日，280–380 万 tokens（含缓冲）。
- 每阶段结束提交验收清单，通过后才进入下一阶段。
