import { useEffect, useState } from 'react';
import { api, type DiscoveryRepoView } from '../api';
import { ErrorBox, Spinner } from './Feedback';

function splitPrefixes(text: string): string[] {
  return text
    .split(/[\n,，]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function DiscoveryReposPanel() {
  const [repos, setRepos] = useState<DiscoveryRepoView[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [repo, setRepo] = useState('');
  const [branch, setBranch] = useState('main');
  const [prefixes, setPrefixes] = useState('');
  const [notes, setNotes] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const result = await api.discoveryRepos();
      setRepos(result.repos);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载发现仓库失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const add = async () => {
    setBusy('add');
    setError(null);
    setNotice(null);
    try {
      const result = await api.createDiscoveryRepo({
        repo: repo.trim(),
        branch: branch.trim() || 'main',
        pathPrefixes: splitPrefixes(prefixes),
        notes: notes.trim(),
      });
      setRepos((current) => [...current, result.repo]);
      setRepo('');
      setPrefixes('');
      setNotes('');
      setNotice(`已添加 ${result.repo.repo}@${result.repo.branch}，下一轮发现会合并扫描`);
    } catch (err) {
      setError(err instanceof Error ? err.message : '添加失败');
    } finally {
      setBusy(null);
    }
  };

  const toggle = async (item: DiscoveryRepoView) => {
    setBusy(item.id);
    setError(null);
    try {
      const result = await api.updateDiscoveryRepo(item.id, { enabled: !item.enabled });
      setRepos((current) => current.map((row) => (row.id === item.id ? result.repo : row)));
    } catch (err) {
      setError(err instanceof Error ? err.message : '更新失败');
    } finally {
      setBusy(null);
    }
  };

  const remove = async (item: DiscoveryRepoView) => {
    if (!window.confirm(`删除自定义仓库 ${item.repo}@${item.branch}？内置仓库不受影响。`)) return;
    setBusy(item.id);
    setError(null);
    try {
      await api.deleteDiscoveryRepo(item.id);
      setRepos((current) => current.filter((row) => row.id !== item.id));
      setNotice(`已删除 ${item.repo}@${item.branch}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败');
    } finally {
      setBusy(null);
    }
  };

  return (
    <details className="panel">
      <summary className="panel-head">
        <h2>发现仓库</h2>
        <span className="muted">内置仓库仍在代码里；这里添加的仓库会合并在下一轮自动发现中</span>
      </summary>
      <div className="panel-body">
        {notice ? <p className="notice">{notice}</p> : null}
        {error ? <ErrorBox message={error} /> : null}
        <div className="run-form">
          <label className="field">
            <span>仓库（owner/repo）</span>
            <input value={repo} onChange={(event) => setRepo(event.target.value)} placeholder="owner/lx-music-source" />
          </label>
          <label className="field compact">
            <span>分支</span>
            <input value={branch} onChange={(event) => setBranch(event.target.value)} placeholder="main" />
          </label>
          <label className="field">
            <span>路径前缀（可选，逗号或换行分隔）</span>
            <input value={prefixes} onChange={(event) => setPrefixes(event.target.value)} placeholder="sources/, kulao/" />
          </label>
          <label className="field">
            <span>备注（可选）</span>
            <input value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="例如：只收 kulao 目录" />
          </label>
          <button
            type="button"
            className="primary-button"
            disabled={busy === 'add' || !repo.trim()}
            onClick={add}
          >
            添加仓库
          </button>
        </div>

        {loading ? <Spinner label="加载发现仓库" /> : null}
        {!loading && repos.length === 0 ? <p className="muted">还没有自定义仓库。内置 6 个仓库仍会继续扫描。</p> : null}
        {!loading && repos.length > 0 ? (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>仓库</th>
                  <th>分支</th>
                  <th>路径前缀</th>
                  <th>状态</th>
                  <th>备注</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {repos.map((item) => (
                  <tr key={item.id}>
                    <td className="mono">{item.repo}</td>
                    <td>{item.branch}</td>
                    <td>{item.pathPrefixes.length ? item.pathPrefixes.join('、') : '全仓库'}</td>
                    <td>
                      <span className={`badge ${item.enabled ? 'badge-ok' : 'badge-idle'}`}>
                        {item.enabled ? '启用' : '停用'}
                      </span>
                    </td>
                    <td>{item.notes || '—'}</td>
                    <td>
                      <div className="chip-row">
                        <button type="button" className="ghost-button" disabled={busy === item.id} onClick={() => void toggle(item)}>
                          {item.enabled ? '停用' : '启用'}
                        </button>
                        <button type="button" className="ghost-button" disabled={busy === item.id} onClick={() => void remove(item)}>
                          删除
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </details>
  );
}
