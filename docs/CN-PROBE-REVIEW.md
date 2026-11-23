# 国内补测 · IPTV 对照与补齐方案

> 对照文档：`iptv-studio/docs/PROXY-SUMMARY.md`（提交 `6dfad83`）
> 本项目：`lx-source-watch`，当前 P5 已上线代理池与 cn 补测最小链路。
> 本文只做分析与方案，不改代码；确认后再实施。

---

## 1. 结论摘要

IPTV 的国内代理体系比我们完整，但两者目标不同：IPTV 要“救活海外测不通的线路”，我们要“回答某个音源平台在国内能不能连”。

我们已经有：代理表、订阅表、加密、导入、mihomo 内核、cn 补测、独立国内标记、cn job。
我们缺的关键能力，按重要性排：

1. **先测代理，再补测**：目前只有 cn 跑起来时才预检，失败节点不落库，UI 看不到“这个节点从 Actions 到底通不通”。
2. **内核节点跳板（dialer-proxy）**：国内专享的 vmess/ss 节点，Actions 直连往往不通，需要先用可用的 HTTP/SOCKS 节点中转。
3. **订阅经代理拉取**：Cloudflare Worker 出口拉机场订阅经常 403，IPTV 是让 Actions 走代理拉；我们现在只能让用户粘贴/传文件。
4. **补测请求头与失败重选**：cn 探测没带 UA，可能被 CDN 误判；选中的代理中途坏了不会换下一个。
5. **出口信息与节点统计**：只有 IP，没有地区/运营商、成功/失败次数，节点多了以后无法判断该用哪个。
6. **订阅体验细节**：file 订阅、自定义 headers、2MB/4 跳转、删除保留可用节点。

不建议照搬：线路 alive/dead 状态机、任务队列/审计、24 小时线路冷却、ADMIN_TOKEN 体系。这些是 IPTV 的线路池语义，音乐源不需要。

---

## 2. 两套场景的差异

| 维度 | IPTV | 音乐源监测 |
|---|---|---|
| 被补测对象 | 固定播放地址（线路） | 每轮脚本解析出的临时 URL |
| 失败含义 | 海外机房不可达，国内可能可播 | 平台取链失败 / 上游 404 / 地域限制 |
| 补测目的 | 把 dead/suspect 线路救回 alive | 给每个“平台”打一个国内可达标记，不改总状态 |
| 状态机 | alive/suspect/dead + failCount | available/partial/unavailable/untested，国内标记独立 |
| 频率 | 空闲时批量补，线路维度 24h 冷却 | 每 4 小时一轮，按平台/URL |
| 代理用途 | 测活、拉订阅、补测 | 补测、拉订阅、内核跳板 |
| 数据量 | 数千线路 | 19 源 / 84 平台 / 约 50–90 条 URL |

结论：**“代理池 + 测活 + 内核 + 补测”这套基础设施可以照搬；“线路状态机 + 调度器”不需要。**

---

## 3. 我们现状盘点

已实现（P5）：

- `apps/worker/migrations/0002_proxies.sql`：proxies 表，密码/内核配置 AES-GCM 加密。
- `apps/worker/migrations/0003_proxy_subscriptions.sql`：订阅实体 + `proxies.subscription_id`。
- `apps/worker/src/proxyImport.ts`：URI / host:port / JSON（含 sing-box outbounds）/ Clash YAML / Base64；`host:port#name` 已支持。
- `apps/worker/src/proxyRoutes.ts`：节点 CRUD、订阅 CRUD/刷新、`/import`、`/import-url`、Bearer 的 `/api/runner/proxies`。
- `apps/runner/src/cn/mihomo.ts`：mihomo v1.19.9 下载/缓存、单节点配置、启动/停止。
- `apps/runner/src/cn/proxyPool.ts`：拉池、预检（ipinfo/ipip 两个目标）、普通优先、最多 8 个。
- `apps/runner/src/cn.ts`：Range 0–256KB、15s、并发 5、写 `cn.json`。
- `apps/runner/src/publish.ts`：`applyCnResults` 把 cn 结果合并进平台 `cn` 字段。
- `.github/workflows/probe.yml`：probe → cn（continue-on-error）→ publish。
- 前端：`/admin/proxies`、浅色/深色、平台 chip 的国内小圆点。

未实现或不足：

| 缺口 | 现状 | 影响 |
|---|---|---|
| 代理独立测活 | 只有 cn 选节点时顺带预检；失败候选不落库 | 不知道节点在 Actions 是否可用；反复试同一个坏节点 |
| 内核跳板 | mihomo 配置只有单节点，无 `dialer-proxy` | 国内专享 vmess/ss 从 Actions 直连基本不通 |
| 订阅经代理拉取 | Worker 直连，CF 出口常 403 | 机场订阅只能手工粘贴/传文件 |
| cn 请求头 | 只带 `range`/`accept` | 部分音乐 CDN 会按 UA 拒绝，误判“国内不可达” |
| 失败重选 | 预检选中后不再换 | 代理中途失效，整轮 cn 全失败 |
| 出口信息 | 只有 `egress_ip` | 无法区分“上海电信/阿里云/海外”，节点多时难选 |
| 节点统计 | 无 success/fail 计数、无 last_country | UI 只能看最近一次 |
| UDP 处理 | hy2/tuic 也会尝试启动 mihomo | 慢且必失败，拖长测活时间 |
| 订阅类型 | 全部当 url，文件导入变“手动节点” | 无法按文件订阅分组/删除 |
| 订阅 headers | 只有 UA | 部分机场要 Referer/自定义头 |
| 401/403 兜底 | 只给文案，让用户粘贴 | 用户体验断点 |
| 导出/统计 | CSV 无 cn 列，总览无“国内可达”统计 | 国内结果只在一处可见 |

---

## 4. IPTV 值得借鉴的点（按优先级）

### P0 · 直接影响结果可信度

**4.1 独立代理测活（proxy-test）**

IPTV：`runProxyTest`，并发 5，UDP 跳过，逐节点回写 `last_*`、成功/失败计数，普通节点优先、内核节点用跳板。

我们：新增 `pnpm proxy-test`，对全部启用节点（或指定 id）逐个测：
- 目标顺序：`ipinfo.io/json` → `myip.ipip.net` → `baidu.com` → `api.ip.sb/geoip`，单目标 5s、总 20s；
- 记录延迟、出口 IP、国家/地区、ISP/ASN、成功时间、错误；
- 普通节点直接测；内核节点启动 mihomo 后测；
- hy2/tuic 标“UDP 不可测”并跳过；
- 并发默认 5（上限 10），结果逐条回写。

**4.2 内核跳板（dialer-proxy）**

IPTV：内核节点测活/补测时，取“启用、非内核、有 lastOkAt”的普通节点按延迟升序最多 3 个，作为 `dialer-proxy` 跳板逐个尝试，全失败再直连一次。

我们：`buildKernelConfig(nodes, port, { dialerProxy? })`，在 mihomo 的 proxy 项里加 `dialer-proxy: <跳板名>`，跳板本身作为另一个 proxy 放进配置。候选来自最近测活成功的普通节点。这个能力决定“国内专享内核节点能不能用”。

**4.3 订阅经代理拉取（解决 403）**

IPTV：`mode=proxy|actions`，runner 预检最多 6 个节点后逐个尝试拉取。

我们：新增 runner 命令 `pnpm fetch-sub -- --url <订阅> --name <名称> --endpoint ... --token ... [--proxy-id <id>]`：
1. 从 `/api/runner/proxies` 取可用普通节点（最近测活成功优先，最多 3 个）；
2. 逐个用该代理 GET 订阅 URL（UA/自定义头、2MB、4 跳转）；
3. 拿到的文本 POST 到新的 `POST /api/runner/import`（Bearer），服务端解析并 upsert 到对应订阅；
4. 全部失败则直连再试一次，并给出中文原因。

这样 Cloudflare 403 不再阻塞，用户只需在 GitHub 上手动跑一次 workflow（后续可加 UI 按钮，见 5.2）。

**4.4 cn 探测带 UA + 失败重选**

- `probeUrl` 增加 `user-agent: <Chrome UA>`（与主探测一致）与 `accept: */*`；
- 结果分类：如果本轮所有行都是连接类错误（ECONNRESET/timeout/代理错误）且没有任何 HTTP 状态，判定“代理坏了”，换下一个预检可用节点重试一次；有 HTTP 状态（如 522/404）则说明代理通、URL 死，不重试；
- 预检失败也要回写 `reportProxyCheck`，让 UI 看到每个节点的状态。

**4.5 出口信息与节点统计**

- proxies 加列：`last_country`、`last_isp`、`last_asn`、`success_count`、`fail_count`；
- `checked_at` 作为“最近检测”；
- UI 节点表展示：地区/运营商、延迟、最近检测、成功/失败次数；
- 顶部统计：总数、启用、可用、失败、未测。

### P1 · 订阅与展示体验

**4.6 订阅类型与请求头**

- `proxy_subscriptions` 加 `kind`（url/file）、`headers`（JSON，最多 20 个，禁 host/content-length/connection）；
- 文件导入可选择“存为文件订阅”，便于分组和删除；
- 正文上限 2MB、最多 4 次跳转（与 IPTV 对齐）。

**4.7 删除订阅的三种方式**

- `delete_all`：订阅和节点都删；
- `keep_alive`：只保留最近测活成功的节点（转为手动）；
- `keep_all`：全部保留为手动节点。

我们现在只有 delete_all/keep（等价 keep_all），补 keep_alive 即可。

**4.8 导出与总览**

- CSV 增加 `cn_tested`、`cn_ok`、`cn_error` 列；
- 总览统计卡增加“国内可达平台数”（有 cn.tested 且 cn.ok 的平台数）；
- 状态筛选之外增加“国内可达/不可达/未测”筛选（可选，低优先）。

### P2 · 可选增强

- 代理“设为当前”与上移/下移（sort_order 已有，补 UI 与 API）；
- 订阅自动刷新（每天一次，Actions 定时 + 代理拉取）；
- 代理自动测活（每天一次）；
- UI 按钮触发 workflow（需要 `GITHUB_DISPATCH_TOKEN`，actions:write，仅本仓库）。

---

## 5. 不建议照搬

| IPTV 做法 | 为什么不抄 |
|---|---|
| 线路 alive/dead 状态机 | 音乐源是平台维度 + 每轮临时 URL，没有稳定“线路”实体 |
| 线路 24h 冷却 | 上游 404/522 可能随时恢复，4 小时一轮重测才有意义 |
| 任务队列/调度器 | 单用户、6 轮/天，GitHub cron 足够 |
| 审计日志 | 无多用户合规需求 |
| ADMIN_TOKEN | 我们已有整站登录 + 独立 RUNNER_TOKEN，边界更清楚 |
| 2MB→64KB 只读前 64KB | 我们读 256KB 上限，能覆盖更多音频头；保持现状 |
| 补测改线路状态 | 用户已明确“国内可达用独立标记，不改 available” |

---

## 6. 建议实施顺序

### P5.1 可靠性最小集（建议先做）

范围：

1. proxies 加 5 列（country/isp/asn/success/fail）；`proxy-test` 命令 + 回写接口扩展；
2. mihomo 跳板 + 内核测活/补测使用跳板；
3. cn 探测加 UA、失败分类、换节点重试、预检失败落库；
4. 新增 `proxy-ops.yml`（workflow_dispatch）：`action=test` 测全部节点；
5. 前端：顶部统计、节点地区/运营商/成功失败、测活全部按钮（先做成“复制命令/去 Actions”也可）。

验收：

- 在 GitHub 手动跑一次 `proxy-ops`，3 个 socks + 1 个 http 节点都能在页面看到“Actions 出口测活”结果（成功/失败、延迟、出口地区）；
- 至少一个节点成功时，cn 补测能跑完并在平台 chip 上出现绿点；
- 故意禁用唯一可用节点后，cn 任务给出明确中文错误而不是静默失败；
- 内核节点在“有可用普通节点”时能通过跳板启动并测通（用用户文件里的 vmess/ss 验证）。

预估：20–30 万 tokens。

### P5.2 订阅体验与 403 兜底

范围：

1. `proxy-ops.yml` 增加 `action=fetch-sub`（url/name/proxy-id）；
2. runner `POST /api/runner/import`（Bearer，2MB）；
3. subscriptions 加 kind/headers；文件订阅；2MB/4 跳转；
4. 删除订阅 keep_alive；
5. CSV/总览增加国内列与统计。

验收：

- 一个会 403 的订阅，通过 `fetch-sub` 走代理成功导入；
- 文件导入可选择“文件订阅”并显示在订阅表；
- CSV 含 cn 列，总览能看到国内可达数。

预估：15–25 万 tokens。

---

## 7. 额度与流量

- 代理测活：每个节点 1–2 次 HTTPS，几十 KB；每天一次可忽略。
- cn 补测：约 50–90 条 URL × ≤256KB，单轮 <10MB；6 轮/天 <60MB；只走代理，不经过 Cloudflare。
- D1：只更新 proxies 行（每节点 1 行），不新增表；订阅/节点数量级 <100，写入可忽略。
- KV：不变（仍是每轮 1 次 snapshot 写）。

---

## 8. 待确认

1. **cn 测试范围**：默认只测“海外失败/未测”的平台，另提供 `--all` 全测？还是维持每轮全测？
2. **cn 频率**：保持每 4 小时，还是每天 1–2 次即可（省代理流量、减少误判）？
3. **先做哪步**：是否按 P5.1 → P5.2 推进？P5.1 里是否包含 UI 按钮，还是先手动跑 workflow？
4. **403 兜底**：是否要做“Actions 经代理拉订阅”（P5.2），还是先用文件/粘贴？
5. **跳板**：内核节点是否启用 dialer-proxy（用可用 socks/http 中转）？
6. **节点导入**：是否先把桌面文件里的 3 个 socks 导入线上，用 P5.1 的测活验证 Actions 可达性？

---

## 9. 附：IPTV 文档未覆盖、我们踩到的点

- Cloudflare Worker 出口拉机场订阅会 403，这是“为什么必须在 Actions 里拉”的直接原因；IPTV 文档只写了 `mode=proxy`，没解释 Worker 侧限制。
- 音乐 CDN 对 UA 敏感，cn 探测不带 UA 会误判；IPTV 的 UA 是自标识，音乐源应伪装成播放器/浏览器 UA。
- sing-box 的 `outbounds` 里混有 `direct/block/urltest` 路由项，导入时必须跳过并计入 warning，否则会生成端口 0 的假节点。
- 同一个节点可能同时出现在 http 与 socks 导出里，家族去重（http/socks5）能避免重复导入。
