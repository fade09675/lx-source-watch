# 国内补测 · IPTV 对照与落地现状

> 对照参考：`iptv-studio`（提交 `6dfad83` 时期的代理/线路实现）。
> 本文记录“哪些照搬、哪些不抄、最后怎么落地”，不再作为待实施清单。

---

## 1. 结论

IPTV 的国内代理体系更完整，但两者目标不同：

- IPTV 要“把海外测不通的线路救回 alive”，线路是稳定实体。
- 我们要“回答某个音源平台/某个接入点在国内能不能连”，URL 每轮由脚本临时解析。

因此照搬“代理池 + 独立测活 + 内核跳板 + 探测后立即补测 + 审计日志”，不照搬“线路 alive/dead 状态机”，也不引入时间冷却或失败地址筛选。

---

## 2. 场景差异

| 维度 | IPTV | 音乐源监测 |
|---|---|---|
| 被补测对象 | 固定播放地址（线路） | 每轮脚本解析出的临时 URL + 音源接入点 |
| 失败含义 | 海外机房不可达，国内可能可播 | 平台取链失败 / 上游 404 / 地域限制 / 脚本失败 |
| 补测目的 | 救回 dead/suspect 线路 | 给平台和接入点各打一个独立“国内可达”标记 |
| 状态机 | alive/suspect/dead + failCount | available/partial/unavailable/untested；国内标记独立 |
| 频率 | 空闲时批量补，线路 24h 冷却 | 每轮探测后立即全量复测全部播放地址 |
| 数据量 | 数千线路 | 19 源 / 约 80 平台 / 50–170 个接入点 |

---

## 3. 已落地能力

### 3.1 代理池与导入

- `proxies` 表：协议、host/port、账号密码、内核配置、启用、最近测活结果、成功/失败计数、订阅归属。
- 密码与内核配置用 AES-GCM（`PROXY_ENC_KEY`，12 字节 IV）加密；页面只显示掩码。
- 导入格式：URI、`host:port`、JSON（含 sing-box outbounds）、Clash YAML、Base64、QX/Surge/Loon 单行、订阅 URL、文件。
- 导入前预览：总数、新增、已存在、内核数、协议分布、样例、warnings；确认后才写库。
- 去重键按“协议族 + host + port + username”，http/socks5 归为同一族，避免同节点重复导入。
- 订阅：URL/文件两种来源，自定义 headers（禁止 Host/Content-Length/Connection/Transfer-Encoding），可改名/刷新/删除。

### 3.2 独立测活

- `proxy-test` 任务由 Worker 派发，runner 逐节点测，逐条回写，最后汇总。
- 目标顺序：`ipinfo.io/json` → `myip.ipip.net` → `baidu.com` → `api.ip.sb/geoip`；单目标 5s、总 20s（可设置）。
- 普通 HTTP/SOCKS 直接测；内核节点启动 mihomo 后测；hy2/tuic 等 UDP 节点标记跳过。
- 记录延迟、出口 IP、国家/地区、ISP/ASN、成功时间、错误；失败节点也落库。
- 并发默认 5（1–10），单节点超时默认 20s（5–90s），均在设置页可调。
- 测活日志页 `/admin/proxy-tests` 可看轮次与逐节点结果，CSV 导出。

### 3.3 内核跳板与冷启动重试

- 内核节点可用“启用、非内核、最近测活成功”的普通节点做 `dialer-proxy` 跳板，最多 5 个，按延迟升序尝试，全失败再直连。
- 跳板数、失败自动换节点均在设置页可调（`cnMaxHops`、`cnAutoSwitch`）。
- mihomo 冷启动第一次 TLS 常被复位：第一次失败后等 1.5s 重试一次，仍失败才判死；错误拼 mihomo 日志末 6 行。
- REALITY/vless 的 YAML 片段按 Clash 原生字段原样保留（`tls/servername/reality-opts/client-fingerprint/network`），不再按 sing-box 字段重建。

### 3.4 平台与接入点补测

- 国内补测是独立任务：探测上报成功后立即创建 `cn-probe` 任务/运行，把本轮全部播放地址按 URL 去重后写 KV；`cn-probe.yml` 拉输入执行。不设时间冷却、不按海外成败筛选、无 200 条上限。
- 平台补测：测主检测解析出的全部播放 URL，Range 256KB、超时 15s；接入点补测对主地址 + 镜像做 Range 请求，结果写 `endpoint.cn`。
- 平台与接入点结果都独立，不改变 `available/partial/unavailable`。
- 任务中心与探测共用 7 项摘要和源/平台失败明细；运行详情按 `checkScope='cn'` 显示独立指标与日志；没有可补测地址时也留一条已完成任务/运行。
- 总览显示“国内可达平台 x/y”，并支持「只看国内失败」筛选；运行详情有接入点「国内」列。

### 3.5 订阅 403 兜底

- Worker 直连拉订阅遇到 401/403 时返回 502 `fetch_forbidden` + `needsRunner`。
- 前端把该订阅行的「用 Actions 拉取」高亮；点击创建 `proxy-fetch-sub` 任务。
- `proxy-fetch-sub.yml` 带 `RUNNER_TOKEN` 启动，runner 先向 Worker 取订阅 URL/UA/headers，再拉取并回传文本；Worker 解析、入库、收尾任务。
- 订阅 UA 回退顺序：订阅自身 UA → 设置里的全局 UA → 内置 UA。

### 3.6 额度与清理

- 额度护栏默认 KV 920/1000、D1 9 万/10 万，达到阈值暂停派发；阈值可在设置页改。
- 运行记录可按天清理：先预览六类计数，确认后删除；永远保留最新一轮探测与最新一轮测活。

---

## 4. 刻意不照搬

| IPTV 做法 | 为什么不抄 |
|---|---|
| 线路 alive/dead 状态机 | 音乐源是平台维度 + 每轮临时 URL，没有稳定“线路”实体 |
| 补测输入绑定线路实体 | 我们按每轮探测的失败 URL + 快照生成输入，不维护长期线路表 |
| 2MB→64KB 只读前 64KB | 我们读 256KB 上限，覆盖更多音频头；保持现状 |
| 补测改线路状态 | 国内可达只做独立标记，不改变海外总状态 |

---

## 5. 踩过的坑

- **Cloudflare Worker 出口拉机场订阅经常 403**：这是必须在 Actions 里拉的直接原因；仅靠 Worker 改 UA 不够。
- **音乐 CDN 对 UA 敏感**：cn 探测不带播放器/浏览器 UA 会误判“国内不可达”。
- **sing-box outbounds 混有 direct/block/urltest**：导入时必须跳过并计入 warning，否则会生成端口 0 的假节点。
- **同一节点可能同时出现在 http 与 socks 导出里**：按协议族去重能避免重复。
- **mihomo 第一次 TLS 被复位**：冷启动必须重试一次，否则内核节点会被误判全死。
- **YAML 片段不是 sing-box 对象**：`tls: true` 是布尔值，按 sing-box 重建会丢 REALITY 字段。
- **任务错误字段有长度上限**：逐节点回写可带完整 900 字符日志，最终汇总必须截到 300，否则整轮上报被拒。
- **Windows 本地跑不了 mihomo**：内核路径只能在 Linux Actions 验证；本地只能验证 HTTP/SOCKS 路径。

---

## 6. 当前边界

- 真实机场订阅 403 的 Actions 全链路尚未用真实订阅验证；已用 httpbin 403 验证识别、提示与接口。
- 国内结果只代表所选代理出口，不代表全国各地区。
- 内核节点剩少数因域名失效、仅 IPv6、跨境 80 端口受限而不可用；`CN-山东电信` 已软停用并保留历史。
- 代码默认开启定时任务；当前线上为手动触发（三个定时任务关闭），开启前先确认额度与单轮耗时。
