# lx-source-watch

LX Music 音源可用性监测。定时在 GitHub Actions 里加载音源脚本，逐个平台取播放地址并做真实拉流校验，把结果汇总成一张「平台 × 可用性 × 延迟」的矩阵，托管在 Cloudflare 上。

> 状态：P3 已完成（Runner / Actions / Worker / KV / D1 本地验收通过），Web 看板与线上部署进行中。

## 它回答什么问题

- 某个音源现在到底能不能用？酷狗、酷我、QQ、网易云、咪咕分别通不通？
- 通过几个平台、测了几个平台，失败的平台是什么原因（HTTP 4xx/5xx、非音频、超时、脚本报错）？
- 延迟多少？最近 14 天是变好还是变差？
- 哪些源值得导入 LX Music？导入链接在哪？

## 核心设计

```
GitHub Actions（每 4 小时）                 Cloudflare
┌──────────────────────────┐        ┌──────────────────────────┐
│ probe job（无任何密钥）   │        │ Worker (Hono)            │
│  ├ 下载音源脚本 ≤2MB      │        │  ├ POST /api/ingest      │
│  ├ vm 沙箱初始化 12s      │        │  │   HMAC 校验 + 幂等     │
│  ├ 逐平台取链（2 首测试曲）│        │  ├ GET  /api/status ...  │
│  ├ Range 拉流 + 魔数校验  │        │  ├ KV  最新快照（每轮 1 写）│
│  └ 产出 status.json       │        │  └ D1  历史/明细/候选     │
├──────────────────────────┤        └──────────────────────────┘
│ publish job（只持密钥）   │  HMAC            ▲
│  └ POST /api/ingest ──────┼──────────────────┘
└──────────────────────────┘
```

- **执行不可信脚本的平面没有密钥**：`probe` job 不注入任何 secret，`persist-credentials: false`；`publish` job 只做 JSON 校验与上报，不执行音源脚本。
- **KV 只存最新快照**（6 写/天），历史与明细进 D1（约 2.6k 行/天，免费额度 ~2.6%）。
- **状态机**：单轮失败只记为 `unavailable`，连续 3 轮全平台失败才标记「持续失效」，避免一次风控误报。
- **国内补测可选**：配置 `CN_PROXY_URL` 后，用境内 HTTP/SOCKS 代理对已解析出的播放地址做二次探测，结果单列，不跟海外结果混在一起。

## 快速开始（本地）

要求 Node 22+、pnpm 11。

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm probe -- --limit 3 --prefer-mirror
pnpm validate
```

产物在 `out/`：`status.json`（快照）、`urls.json`（本轮解析出的地址）、`candidates.json`（自动发现候选）。

### 常用命令

| 命令 | 作用 |
|---|---|
| `pnpm probe` | 探测清单内全部源 |
| `pnpm probe -- --only qingliang --deep` | 只测一个源，测更高音质 |
| `pnpm discover` | 从 GitHub 仓库发现候选脚本（只存链接） |
| `pnpm candidates -- --limit 20` | 对候选做初始化体检 |
| `pnpm cn` | 用 `CN_PROXY_URL` 对已解析地址做国内补测 |
| `pnpm ingest -- --snapshot out/status.json --dry-run` | 生成本轮上报体，不发网络 |
| `pnpm validate` | 校验清单与快照 schema |

## 目录

```
apps/runner      Node 探测器（vm 沙箱、取链、拉流校验、发现、国内补测、上报）
apps/worker      Cloudflare Worker（Hono API、KV 快照、D1 历史）
packages/shared  schema / 平台表 / 状态机 / 错误分类 / 测试曲
sources/         registry.json（固定清单）、discovery.json（自动发现仓库）
docs/SPEC.md     冻结的产品与数据契约
docs/DEPLOY.md   部署手册
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
