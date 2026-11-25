# lx-source-watch

LX Music 音源可用性监测。定时在 GitHub Actions 里加载音源脚本，逐个平台取播放地址并做真实拉流校验，把结果汇总成「平台 × 可用性 × 延迟」的矩阵，托管在 Cloudflare 上。站点整站登录，面向单人或小团队自用。

> 状态：P0–P5、阶段 4A–4F、阶段 5 与阶段 6A/6B 已完成并上线（2026-11-25）；阶段 6C 回归收尾进行中。线上站点：<https://dash.dpdns.org>。

## 它回答什么问题

- 某个音源现在到底能不能用？酷狗、酷我、QQ、网易云、咪咕分别通不通？
- 通过几个平台、测了几个平台，失败的平台是什么原因（HTTP 4xx/5xx、非音频、超时、脚本报错）？
- 延迟多少？最近 14 天是变好还是变差？
- 哪些源值得导入 LX Music？导入链接在哪？国内网络能不能连？

## 核心设计

```
GitHub Actions                          Cloudflare
┌────────────────────────┐              ┌────────────────────────┐
│ probe job（无任何密钥）  │              │ Worker (Hono)          │
│  下载音源脚本 ≤2MB      │              │  POST /api/ingest      │
│  vm 沙箱初始化 12s      │              │   HMAC 校验 + 幂等      │
│  逐平台取链（2 首测试曲）│  ── HMAC ──▶ │  GET  /api/status ...  │
│  Range 拉流 + 魔数校验   │              │  KV  最新快照（每轮 1 写）│
│  产出 status.json       │              │  D1  历史/明细/候选/设置 │
└────────────────────────┘              └────────────────────────┘
```

- **执行不可信脚本的平面没有密钥**：`probe` job 不注入业务 secret，`persist-credentials: false`；`publish` job 只做 JSON 校验与上报，不执行音源脚本。
- **Worker 定时**：cron 每 5 分钟唤醒一次，按设置判断探测（默认 4 小时）、代理测活（默认 6 小时）、自动发现（默认 12 小时）是否到点，再派发 GitHub 工作流；手动触发时间参与判断。
- **多接入点**：每个源 = 主地址 + 最多 10 个自定义镜像 + 加速模板，合计最多 16 个接入点；每轮下载全部接入点，按 sha 标记「同版本 / 版本落后」，平台测试优先主地址、其次同版本镜像。
- **KV 只存最新快照**，历史与明细进 D1；额度护栏默认 KV 920/1000、D1 9 万/10 万，达到阈值自动暂停派发，阈值可在设置页改。
- **状态机**：单轮失败只记为 `unavailable`，连续 3 轮全平台失败才标记「持续失效」，避免一次风控误报。
- **国内补测**：走自备 HTTP/SOCKS 代理或 mihomo 内核节点，分别标记「平台国内可达」和「接入点国内可达」，不改变总状态；内核节点可用普通节点做跳板，失败自动换节点。
- **订阅 403 兜底**：Worker 拉订阅被 403/401 时返回结构化 `needsRunner`，前端高亮「用 Actions 拉取」，由 Actions 出口带 `RUNNER_TOKEN` 和订阅自定义 UA/headers 拉取后回传。

## 管理后台

- **工作台**：额度卡片（KV/D1/Actions）、任务中心、最近运行、运行日志。
- **音源总览**：平台矩阵，逐源显示接入点数、镜像版本落后、国内可达平台数；支持状态/平台/分类/关键词/「只看国内失败」筛选。
- **音源管理**：新增/编辑/删除/启停，版本与 sha、最近变化、导入链接（主地址 + 自定义镜像 + 加速模板）；重复源按 sha 合并为别名。
- **候选源**：从多个 GitHub 仓库自动发现脚本（每仓库每轮有上限），初始化体检，自动/手动收录；可按仓库筛选。自动收录会跳过“标题+作者相同但内容不同”的相似候选，留给人工确认，避免同名搬运版被重复收录。
- **国内代理**：订阅与节点管理、导入预览/去重、独立测活与测活日志、mihomo 内核与跳板、成功率与地区。
- **运行与日志**：失败聚合、平台汇总（含国内列）、逐轮明细、逐源/接入点/平台三级详情。
- **设置**：探测/测活/发现调度、国内补测（UA、代理数、并发、跳板数、自动换节点）、测活并发/超时、自动收录、数据保留、加速镜像、额度护栏；管理页可预览并清理旧运行记录（永远保留最新一轮）。

## 快速开始（本地）

要求 Node 22+、pnpm 11（本机 pnpm 不在 PATH 时用 `corepack pnpm`）。

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm probe -- --limit 3 --prefer-mirror
pnpm validate
```

本地起 Worker + 前端：

```bash
pnpm dev:worker     # Worker，默认 8787，需要 apps/worker/.dev.vars
pnpm dev:web        # 前端开发服务器
pnpm build          # 构建前端产物到 apps/web/dist，供 wrangler 静态资源使用
```

产物在 `out/`：`status.json`（快照）、`urls.json`（本轮解析出的地址）、`candidates.json`（自动发现候选）。

### 常用命令

| 命令 | 作用 |
|---|---|
| `pnpm probe` | 探测清单内全部源 |
| `pnpm probe -- --only qingliang --deep` | 只测一个源，测更高音质 |
| `pnpm discover` | 从配置的多个 GitHub 仓库发现候选脚本（只存链接） |
| `pnpm candidates -- --limit 20` | 对候选做初始化体检 |
| `pnpm proxy-test` | 独立测活代理池 |
| `pnpm proxy-fetch -- --sub-id <id> --run-id <id>` | 由 Actions 拉取被 403 的订阅并回传 |
| `pnpm cn` | 用代理对失败地址和接入点做国内补测（默认只测失败项） |
| `pnpm ingest -- --snapshot out/status.json --dry-run` | 生成本轮上报体，不发网络 |
| `pnpm validate` | 校验清单与快照 schema |
| `pnpm db:migrate` | 本地 D1 应用迁移 |

`cn`、`proxy-test`、`proxy-fetch`、`ingest` 需要运行参数：本地可传 `--proxy`/`--endpoint`/`--token`，或设 `CN_PROXY_URL`、`INGEST_URL`、`RUNNER_TOKEN`。`proxy-fetch` 还必须有对应的占位运行 `--run-id`。

## 目录

```
apps/runner      Node 探测器（vm 沙箱、取链、拉流校验、发现、国内补测、上报）
apps/worker      Cloudflare Worker（Hono API、KV 快照、D1 历史、定时调度）
apps/web         React 管理后台（工作台/总览/音源管理/候选/代理/日志/设置）
packages/shared  schema / 平台表 / 状态机 / 错误分类 / 测试曲 / 镜像模板
sources/         registry.json（初始清单）、discovery.json（自动发现仓库）
docs/SPEC.md     产品与数据契约（当前版本）
docs/DEPLOY.md   部署手册
docs/CN-PROBE-REVIEW.md  国内补测与 IPTV 对照的落地记录
```

## 数据与合规

- 仓库**不托管任何音频文件**，只保存音源脚本的 URL 与检测结果（是否可播放、延迟、错误原因）。
- 测试曲只用于构造 `musicUrl` 请求，不下载完整歌曲；拉流校验只读前 2KB 判断容器魔数。
- 音源脚本来自第三方仓库，本项目只做可用性事实记录，不对其内容与合法性背书。
- 如果你是版权方并认为某项内容不当，请开 issue，我们会移除对应链接。
- 自动发现只保存候选链接，不复制、不再分发第三方脚本；公开托管的 `.js` 仅限维护者主动放入 `sources/local/` 的文件。

## 部署

见 [docs/DEPLOY.md](docs/DEPLOY.md)：Cloudflare 登录 → 建 KV/D1 → 迁移 → 部署 → 推送仓库 → 配 Actions secrets → 首轮上报。

## License

MIT
