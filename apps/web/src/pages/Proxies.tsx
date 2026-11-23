import { useEffect, useState } from 'react';
import { ApiError, api, type AdminProxy } from '../api';
import { ErrorBox, Spinner } from '../components/Feedback';

const PROTOCOLS = ['http', 'socks5', 'ss', 'vmess', 'vless', 'trojan', 'hysteria2', 'tuic', 'anytls'];

export function ProxiesPage() {
  const [items, setItems] = useState<AdminProxy[] | null>(null);
  const [error, setError] = useState('');
  const [text, setText] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ name: '', protocol: 'http', host: '', port: '', username: '', password: '', config: '' });

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setError('');
    try {
      const result = await api.proxies();
      setItems(result.items);
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

  async function importText() {
    await run(async () => {
      const result = await api.importProxies(text);
      setText('');
      return result;
    }, '导入完成');
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

  const kernelForm = ['ss', 'vmess', 'vless', 'trojan', 'hysteria2', 'tuic', 'anytls'].includes(form.protocol);

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

      <section className="panel">
        <h2>批量导入</h2>
        <p className="muted small">支持 Clash YAML、Base64 订阅、分享链接（ss:// vmess:// trojan:// vless://）、host:port 或 host:port:user:pass，一行一个。</p>
        <textarea
          className="proxy-textarea"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="把订阅内容粘贴到这里…"
          rows={6}
        />
        <div className="page-actions">
          <button type="button" className="primary-button" disabled={busy || !text.trim()} onClick={() => void importText()}>
            导入
          </button>
        </div>
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
          <h2>已启用节点（{items.filter((item) => item.enabled).length}/{items.length}）</h2>
          {items.length === 0 && <p className="muted">还没有节点。导入订阅后，Actions 的 cn job 会自动测活并回写结果。</p>}
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>名称</th>
                  <th>协议 / 地址</th>
                  <th>最近测活</th>
                  <th>出口</th>
                  <th>状态</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <div>{item.name}</div>
                      {item.kernelOnly && <span className="pill pill-idle">内核</span>}
                    </td>
                    <td className="mono small">
                      {item.protocol}://{item.host}:{item.port}
                    </td>
                    <td className="small muted">{item.lastOkAt ? new Date(item.lastOkAt).toLocaleString('zh-CN') : item.lastError ?? '未测'}</td>
                    <td className="small mono">{item.egressIp ?? '—'}</td>
                    <td>
                      <span className={`pill ${item.enabled ? 'pill-ok' : 'pill-idle'}`}>{item.enabled ? '启用' : '停用'}</span>
                      {item.lastLatencyMs ? <span className="small muted"> {item.lastLatencyMs}ms</span> : null}
                    </td>
                    <td className="row-actions">
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
        </section>
      )}
    </div>
  );
}
