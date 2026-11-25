import { useEffect, useMemo, useState } from 'react';
import { ApiError, api, type AdminProxy, type ProxyImportPreview, type SubscriptionItem } from '../api';
import { ErrorBox, Spinner } from '../components/Feedback';
import { Pagination, useClientPager } from '../components/Pagination';

const PROTOCOLS = ['http', 'socks5', 'ss', 'vmess', 'vless', 'trojan', 'hysteria2', 'tuic', 'anytls'];

const UA_PRESETS = [
  { label: '默认（本站 UA）', value: '' },
  { label: 'Clash for Windows', value: 'ClashforWindows/0.20.39' },
  { label: 'Clash Meta', value: 'clash.meta/1.18.0' },
  { label: 'Shadowrocket', value: 'Shadowrocket/2.2.9 CFNetwork/1490 Darwin/23.4.0' },
  { label: 'V2RayN', value: 'v2rayN/6.31' },
  { label: '浏览器', value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36' },
];

function shortTime(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function ProxiesPage() {
  const [items, setItems] = useState<AdminProxy[] | null>(null);
  const [subs, setSubs] = useState<SubscriptionItem[] | null>(null);
  const [error, setError] = useState('');
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<ProxyImportPreview | null>(null);
  const [pendingText, setPendingText] = useState('');
  const [subUrl, setSubUrl] = useState('');
  const [subName, setSubName] = useState('');
  const [subUa, setSubUa] = useState('');
  const [subHeaders, setSubHeaders] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testingAll, setTestingAll] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [fetchFallbackId, setFetchFallbackId] = useState<string | null>(null);
  const [filterSub, setFilterSub] = useState('');
  const [form, setForm] = useState({ name: '', protocol: 'http', host: '', port: '', username: '', password: '', config: '' });

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setError('');
    try {
      const [proxyResult, subResult] = await Promise.all([api.proxies(), api.subscriptions()]);
      setItems(proxyResult.items);
      setSubs(subResult.items);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '加载失败');
    }
  }

  async function run(action: () => Promise<unknown>, okText: string) {
    setBusy(true);
    setMessage('');
    try {
      await action();
      setMessage(okText);
      await load();
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : '操作失败');
    } finally {
      setBusy(false);
    }
  }

  async function previewContent(content: string, source: '文本' | '文件') {
    if (!content.trim()) {
      setMessage('请先粘贴或选择要导入的内容');
      return;
    }
    setBusy(true);
    setMessage('');
    try {
      const result = await api.previewProxies(content);
      setPreview(result);
      setPendingText(content);
      setMessage(
        `${source}预览：识别 ${result.total} 个，新增 ${result.added}，已存在 ${result.duplicates}（将更新），内核 ${result.kernelOnly} 个`,
      );
    } catch (e) {
      setPreview(null);
      setPendingText('');
      setMessage(e instanceof ApiError ? e.message : '预览失败');
    } finally {
      setBusy(false);
    }
  }

  async function importText(content = pendingText || text) {
    if (!content.trim()) {
      setMessage('请先预览或粘贴要导入的内容');
      return;
    }
    setBusy(true);
    setMessage('');
    try {
      const result = await api.importProxies(content);
      setMessage(`导入完成：新增 ${result.added}，更新 ${result.updated}，共 ${result.total} 个节点${result.warnings.length ? `；${result.warnings[0]}` : ''}`);
      setText('');
      setPreview(null);
      setPendingText('');
      await load();
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : '导入失败');
    } finally {
      setBusy(false);
    }
  }

  async function previewFile(file: File) {
    if (file.size > 512 * 1024) {
      setMessage('文件超过 512KB，请拆分后再导入');
      return;
    }
    try {
      const content = await file.text();
      await previewContent(content, '文件');
    } catch {
      setMessage('读取文件失败');
    }
  }

  async function addSubscription() {
    setBusy(true);
    setMessage('');
    try {
      const result = await api.importProxyUrl(
        subUrl.trim(),
        subName.trim() || undefined,
        subUa.trim() || undefined,
        subHeaders.trim() || undefined,
      );
      setMessage(
        `已添加订阅「${result.subscription?.name ?? subName.trim() ?? '订阅'}」：新增 ${result.added}，更新 ${result.updated}，共 ${result.total} 个节点${result.warnings.length ? `；${result.warnings[0]}` : ''}`,
      );
      setSubUrl('');
      setSubName('');
      setSubUa('');
      setSubHeaders('');
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.needsRunner) {
        setMessage('Worker 被 403 拦截：请把订阅内容粘贴到下方「批量导入」，或下载后上传文件。');
      } else {
        setMessage(e instanceof ApiError ? e.message : '订阅导入失败');
      }
    } finally {
      setBusy(false);
    }
  }

  async function refreshSub(item: SubscriptionItem) {
    setBusy(true);
    setMessage('');
    try {
      const result = await api.refreshSubscription(item.id);
      setFetchFallbackId(null);
      setMessage(`刷新「${item.name}」完成：新增 ${result.added}，更新 ${result.updated}，共 ${result.total} 个节点`);
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.needsRunner) {
        setFetchFallbackId(item.id);
        setMessage(`Worker 被 403 拦截：「${item.name}」请点这一行的「用 Actions 拉取」，由 GitHub Actions 拉取后回传。`);
      } else {
        setMessage(e instanceof ApiError ? e.message : '刷新失败');
      }
    } finally {
      setBusy(false);
    }
  }

  async function fetchSubViaActions(item: SubscriptionItem) {
    setBusy(true);
    setMessage('');
    try {
      await api.createTask({ type: 'proxy-fetch-sub', payload: { subscriptionId: item.id } });
      setFetchFallbackId(null);
      setMessage(`已派发 Actions 拉取「${item.name}」，通常 30–60 秒内完成，之后刷新查看结果。`);
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : '派发失败');
    } finally {
      setBusy(false);
    }
  }

  async function saveName(item: SubscriptionItem) {
    const name = editingName.trim();
    if (!name || name === item.name) {
      setEditingId(null);
      return;
    }
    await run(() => api.updateSubscription(item.id, { name }), '订阅名称已更新');
    setEditingId(null);
  }

  async function removeSub(item: SubscriptionItem, nodes: 'delete_all' | 'keep') {
    setBusy(true);
    setMessage('');
    try {
      const result = await api.deleteSubscription(item.id, nodes);
      setMessage(nodes === 'delete_all' ? `已删除订阅及其 ${result.deleted} 个节点` : '已删除订阅，节点已保留为手动节点');
      setDeletingId(null);
      await load();
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : '删除失败');
    } finally {
      setBusy(false);
    }
  }

  async function addManual() {
    await run(
      () =>
        api.createProxy({
          name: form.name,
          protocol: form.protocol,
          host: form.host,
          port: Number(form.port),
          username: form.username,
          password: form.password,
          config: form.config || undefined,
        }),
      '已添加',
    );
    setForm({ name: '', protocol: 'http', host: '', port: '', username: '', password: '', config: '' });
  }

  async function triggerTest(proxyId?: string) {
    if (proxyId) setTestingId(proxyId);
    else setTestingAll(true);
    setMessage('');
    try {
      await api.runProxyTest(proxyId ? { proxyId } : {});
      setMessage(
        proxyId
          ? '已触发该节点的测活，Actions 通常 30–60 秒内开始，稍后刷新查看结果'
          : '已触发全部节点测活，Actions 通常 30–60 秒内开始，稍后刷新查看结果',
      );
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : '触发测活失败');
    } finally {
      setTestingId(null);
      setTestingAll(false);
    }
  }

  const kernelForm = ['ss', 'vmess', 'vless', 'trojan', 'hysteria2', 'tuic', 'anytls'].includes(form.protocol);
  const visible = useMemo(() => {
    if (!items) return [];
    if (!filterSub) return items;
    if (filterSub === '__manual__') return items.filter((item) => !item.subscriptionId);
    return items.filter((item) => item.subscriptionId === filterSub);
  }, [items, filterSub]);
  const subPager = useClientPager(subs ?? []);
  const nodePager = useClientPager(visible);
  const nodeTotal = items?.length ?? 0;
  const nodeEnabled = items?.filter((item) => item.enabled).length ?? 0;
  const nodeOk = items?.filter((item) => item.lastOkAt).length ?? 0;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>国内代理池</h1>
          <p className="muted">国内补测会从这里自动挑一个可用节点；密码用 AES-GCM 加密存储，只对 Actions 的 cn job 解密。</p>
        </div>
      </div>

      {message && <div className="notice">{message}</div>}
      {error && <ErrorBox message={error} onRetry={() => void load()} />}
      {!items && !error && <Spinner label="正在加载代理池…" />}

      {items && (
        <div className="stats-grid compact">
          <div className="stat-card">
            <span className="muted">节点总数</span>
            <strong>{nodeTotal}</strong>
            <span className="muted small">启用 {nodeEnabled} 个</span>
          </div>
          <div className="stat-card">
            <span className="muted">最近测活可用</span>
            <strong className={nodeOk > 0 ? 'text-ok' : 'muted'}>{nodeOk}</strong>
            <span className="muted small">有过成功记录</span>
          </div>
          <div className="stat-card">
            <span className="muted">订阅</span>
            <strong>{subs?.length ?? 0}</strong>
            <span className="muted small">按订阅归档节点</span>
          </div>
        </div>
      )}

      <section className="panel">
        <h2>订阅</h2>
        <p className="muted small">
          添加机场订阅链接（http/https），服务端拉取内容后按订阅归档节点；之后可改名、刷新、停用或删除。订阅链接本身不会再被当成节点。
        </p>
        <div className="proxy-form">
          <label className="wide">
            订阅地址
            <input
              value={subUrl}
              onChange={(event) => setSubUrl(event.target.value)}
              placeholder="https://example.com/api/v1/client/subscribe?token=..."
            />
          </label>
          <label>
            订阅名称（可选）
            <input value={subName} onChange={(event) => setSubName(event.target.value)} placeholder="例如 机场A" />
          </label>
          <label>
            UA（可选）
            <input
              value={subUa}
              onChange={(event) => setSubUa(event.target.value)}
              placeholder="默认使用本站 UA，可从下拉里选"
              list="ua-presets"
            />
            <datalist id="ua-presets">
              {UA_PRESETS.map((preset) => (
                <option key={preset.label} value={preset.value}>
                  {preset.label}
                </option>
              ))}
            </datalist>
          </label>
          <label className="wide">
            自定义请求头（可选，每行 Key: value）
            <textarea
              className="proxy-textarea"
              rows={2}
              value={subHeaders}
              onChange={(event) => setSubHeaders(event.target.value)}
              placeholder={'X-Client: clash\nX-Token: ...'}
            />
          </label>
          <div className="wide page-actions">
            <button type="button" className="primary-button" disabled={busy || !subUrl.trim()} onClick={() => void addSubscription()}>
              添加订阅并拉取
            </button>
          </div>
        </div>
        <p className="muted small">
          如果提示 403：机场多半限制了海外/机房 IP 或要求特定 UA。可以先在下拉里换一个 UA 重试；仍然不行就在浏览器打开订阅链接，把内容复制到下面“批量导入”，或用文件导入。
        </p>

        {subs && subs.length > 0 && (
          <div className="table-wrap">
            <table className="data-table responsive-table proxy-sub-table">
              <thead>
                <tr>
                  <th>订阅名称</th>
                  <th>节点</th>
                  <th>最近拉取</th>
                  <th>状态</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {subPager.pageItems.map((item) => (
                  <tr key={item.id}>
                    <td data-label="订阅">
                      {editingId === item.id ? (
                        <div className="row-actions">
                          <input
                            value={editingName}
                            onChange={(event) => setEditingName(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') void saveName(item);
                              if (event.key === 'Escape') setEditingId(null);
                            }}
                            autoFocus
                          />
                          <button type="button" className="ghost-button" disabled={busy} onClick={() => void saveName(item)}>
                            保存
                          </button>
                          <button type="button" className="ghost-button" onClick={() => setEditingId(null)}>
                            取消
                          </button>
                        </div>
                      ) : (
                        <div>
                          <div>
                            {item.name}
                            {item.kind === 'file' && <span className="pill pill-idle" style={{ marginLeft: 8 }}>文件</span>}
                          </div>
                          <div className="small muted mono" title={item.url}>
                            {item.kind === 'file' ? '由文件导入，不能在线刷新' : item.url.length > 52 ? `${item.url.slice(0, 52)}…` : item.url}
                          </div>
                        </div>
                      )}
                    </td>
                    <td className="small" data-label="节点">{item.nodeCount}</td>
                    <td className="small muted" data-label="最近拉取">{shortTime(item.lastFetchAt)}</td>
                    <td className="small" data-label="状态">
                      <div className="cell-stack">
                        <span className={`pill ${item.enabled ? 'pill-ok' : 'pill-idle'}`}>{item.enabled ? '启用' : '停用'}</span>
                        <div className="muted" title={item.lastStatus}>
                          {item.lastStatus.length > 34 ? `${item.lastStatus.slice(0, 34)}…` : item.lastStatus}
                        </div>
                        {fetchFallbackId === item.id ? (
                          <div className="small" style={{ color: 'var(--bad)' }}>
                            Worker 返回 403，请用 Actions 拉取
                          </div>
                        ) : null}
                      </div>
                    </td>
                    <td className="row-actions" data-label="">
                      {deletingId === item.id ? (
                        <>
                          <button type="button" className="ghost-button danger" disabled={busy} onClick={() => void removeSub(item, 'delete_all')}>
                            删除订阅和节点
                          </button>
                          <button type="button" className="ghost-button" disabled={busy} onClick={() => void removeSub(item, 'keep')}>
                            仅删订阅
                          </button>
                          <button type="button" className="ghost-button" onClick={() => setDeletingId(null)}>
                            取消
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="ghost-button"
                            disabled={busy || item.kind === 'file'}
                            title={item.kind === 'file' ? '文件订阅不能在线刷新，请重新上传文件' : '重新拉取订阅'}
                            onClick={() => void refreshSub(item)}
                          >
                            刷新
                          </button>
                          <button
                            type="button"
                            className={fetchFallbackId === item.id ? 'primary-button' : 'ghost-button'}
                            disabled={busy || item.kind === 'file'}
                            title={item.kind === 'file' ? '文件订阅不能派发 Actions 拉取' : 'Worker 拉取失败时，改让 GitHub Actions 拉取并回传'}
                            onClick={() => void fetchSubViaActions(item)}
                          >
                            用 Actions 拉取
                          </button>
                          <button
                            type="button"
                            className="ghost-button"
                            disabled={busy}
                            onClick={() => {
                              setEditingId(item.id);
                              setEditingName(item.name);
                            }}
                          >
                            改名
                          </button>
                          <button
                            type="button"
                            className="ghost-button"
                            disabled={busy}
                            onClick={() => void run(() => api.updateSubscription(item.id, { enabled: !item.enabled }), item.enabled ? '已停用订阅' : '已启用订阅')}
                          >
                            {item.enabled ? '停用' : '启用'}
                          </button>
                          <button type="button" className="ghost-button danger" disabled={busy} onClick={() => setDeletingId(item.id)}>
                            删除
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {subs && subs.length > 0 && <Pagination {...subPager.pagination} label="个订阅" />}
        {subs && subs.length === 0 && <p className="muted small">还没有订阅。添加后节点会自动出现在下方列表，并按订阅归档。</p>}
      </section>

      <section className="panel">
        <h2>批量导入</h2>
        <p className="muted small">
          支持 Clash YAML、Base64 订阅、分享链接（ss:// vmess:// trojan:// vless://）、host:port 或 host:port:user:pass，一行一个。
          订阅链接在浏览器能打开、但服务端拉取报 403 时，用这里粘贴或上传文件最稳。
        </p>
        <textarea
          className="proxy-textarea"
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setPreview(null);
            setPendingText('');
          }}
          placeholder="把订阅内容粘贴到这里…"
          rows={6}
        />
        <div className="page-actions">
          <button type="button" className="ghost-button" disabled={busy || !text.trim()} onClick={() => void previewContent(text, '文本')}>
            预览
          </button>
          <button type="button" className="primary-button" disabled={busy || !text.trim()} onClick={() => void importText(text)}>
            直接导入
          </button>
          <label className="ghost-button file-button">
            从文件预览
            <input
              type="file"
              accept=".txt,.yaml,.yml,.json,.conf,.ini"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void previewFile(file);
                event.target.value = '';
              }}
            />
          </label>
        </div>
        {preview ? (
          <div className="notice">
            <p>
              将导入 <strong>{preview.total}</strong> 个：新增 <strong>{preview.added}</strong>，已存在{' '}
              <strong>{preview.duplicates}</strong>（会更新密码/配置），内核 <strong>{preview.kernelOnly}</strong> 个
            </p>
            <p className="muted small">
              协议分布：{preview.protocols.map((item) => `${item.protocol} ${item.count}`).join('、') || '—'}
            </p>
            <p className="muted small">
              样例：{preview.sample.map((node) => `${node.name}（${node.protocol} ${node.host}:${node.port}）`).join('；')}
            </p>
            {preview.warnings.length ? <p className="muted small">提示：{preview.warnings.join('；')}</p> : null}
            <div className="page-actions">
              <button type="button" className="primary-button" disabled={busy || !pendingText} onClick={() => void importText(pendingText)}>
                确认导入
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={() => {
                  setPreview(null);
                  setPendingText('');
                }}
              >
                取消
              </button>
            </div>
          </div>
        ) : null}
      </section>

      <details className="panel">
        <summary>手动添加一个节点</summary>
        <div className="proxy-form">
          <label>
            名称
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="例如 上海电信" />
          </label>
          <label>
            协议
            <select value={form.protocol} onChange={(e) => setForm({ ...form, protocol: e.target.value })}>
              {PROTOCOLS.map((protocol) => (
                <option key={protocol} value={protocol}>
                  {protocol}
                </option>
              ))}
            </select>
          </label>
          <label>
            主机
            <input value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="1.2.3.4" />
          </label>
          <label>
            端口
            <input value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} placeholder="8080" inputMode="numeric" />
          </label>
          <label>
            用户名
            <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
          </label>
          <label>
            密码
            <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </label>
          {kernelForm && (
            <label className="wide">
              节点配置（分享链接 / Clash YAML / JSON）
              <textarea rows={3} value={form.config} onChange={(e) => setForm({ ...form, config: e.target.value })} />
            </label>
          )}
          <div className="wide page-actions">
            <button type="button" className="primary-button" disabled={busy || !form.host || !form.port} onClick={() => void addManual()}>
              添加
            </button>
          </div>
        </div>
      </details>

      {items && (
        <section className="panel">
          <div className="page-head">
            <h2>节点（{items.filter((item) => item.enabled).length}/{items.length} 启用）</h2>
            <div className="page-actions">
              <button
                type="button"
                className="ghost-button"
                disabled={testingAll || testingId !== null}
                onClick={() => void triggerTest()}
              >
                {testingAll ? '触发中…' : '测活全部'}
              </button>
              <label className="small muted">
                来源筛选
                <select
                  value={filterSub}
                  onChange={(event) => {
                    setFilterSub(event.target.value);
                    nodePager.reset();
                  }}
                >
                  <option value="">全部</option>
                  <option value="__manual__">手动添加</option>
                  {subs?.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>
          {items.length === 0 && <p className="muted">还没有节点。导入订阅后，Actions 的 cn job 会自动测活并回写结果。</p>}
          {visible.length > 0 && (
            <div className="table-wrap">
              <table className="data-table responsive-table proxy-node-table">
                <thead>
                  <tr>
                    <th>名称 / 来源</th>
                    <th>协议 / 地址</th>
                    <th>最近测活</th>
                    <th>出口 / 地区</th>
                    <th>成功率</th>
                    <th>状态</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {nodePager.pageItems.map((item) => (
                    <tr key={item.id}>
                      <td data-label="名称">
                        <div className="cell-stack cell-stack-left">
                          <div>{item.name}</div>
                          <div className="small muted">
                            {item.subscriptionName ?? '手动'}
                            {item.kernelOnly && <span className="pill pill-idle"> 内核</span>}
                          </div>
                        </div>
                      </td>
                      <td className="mono small" data-label="地址">
                        {item.protocol}://{item.host}:{item.port}
                      </td>
                      <td className="small muted" data-label="最近测活">{item.lastOkAt ? shortTime(item.lastOkAt) : item.lastError ?? '未测'}</td>
                      <td className="small mono" data-label="出口">
                        <div className="cell-stack">
                          <div>{item.egressIp ?? '—'}</div>
                          {(item.country || item.asn) && (
                            <div className="muted">
                              {[item.country, item.asn].filter(Boolean).join(' · ')}
                            </div>
                          )}
                        </div>
                      </td>
                      <td className="small muted" data-label="成功率">
                        {item.successCount + item.failCount > 0
                          ? `${item.successCount}/${item.successCount + item.failCount}`
                          : '—'}
                      </td>
                      <td data-label="状态">
                        <div className="cell-stack">
                          <span className={`pill ${item.enabled ? 'pill-ok' : 'pill-idle'}`}>{item.enabled ? '已启用' : '停用'}</span>
                          {item.lastLatencyMs ? <span className="small muted"> {item.lastLatencyMs}ms</span> : null}
                          {item.enabled && !item.lastOkAt ? <span className="small text-bad"> 最近未测活成功</span> : null}
                        </div>
                      </td>
                      <td className="row-actions" data-label="">
                        <button
                          type="button"
                          className="ghost-button"
                          disabled={testingId !== null || testingAll}
                          onClick={() => void triggerTest(item.id)}
                        >
                          {testingId === item.id ? '触发中…' : '测活'}
                        </button>
                        <button
                          type="button"
                          className="ghost-button"
                          disabled={busy}
                          onClick={() => void run(() => api.updateProxy(item.id, { enabled: !item.enabled }), item.enabled ? '已停用' : '已启用')}
                        >
                          {item.enabled ? '停用' : '启用'}
                        </button>
                        <button
                          type="button"
                          className="ghost-button danger"
                          disabled={busy}
                          onClick={() => void run(() => api.deleteProxy(item.id), '已删除')}
                        >
                          删除
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {visible.length > 0 && <Pagination {...nodePager.pagination} label="个节点" />}
        </section>
      )}
    </div>
  );
}
