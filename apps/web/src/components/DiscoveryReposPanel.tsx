import { useEffect, useState } from 'react';
import { api, type DiscoveryRepoView } from '../api';
import { RepoUrlError, parseRepoUrl, type RepoUrlImport } from '../lib/repoUrl';
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
  const [url, setUrl] = useState('');
  const [parsedUrl, setParsedUrl] = useState<RepoUrlImport | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

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

  const applyUrl = () => {
    setParseError(null);
    try {
      const parsed = parseRepoUrl(url, branch.trim() || 'main');
      setParsedUrl(parsed);
      setRepo(parsed.repo);
      setBranch(parsed.branch);
      setPrefixes(parsed.pathPrefixes.join(', '));
      setNotice(null);
      setError(null);
    } catch (err) {
      setParsedUrl(null);
      setParseError(err instanceof RepoUrlError ? err.message : '无法解析这个仓库链接');
    }
  };

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
      setUrl('');
      setParsedUrl(null);
      setParseError(null);
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
        <div className="repo-url-import">
          <label className="field">
            <span>粘贴 GitHub 仓库链接</span>
            <input
              value={url}
              onChange={(event) => {
                setUrl(event.target.value);
                setParsedUrl(null);
                setParseError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  applyUrl();
                }
              }}
              placeholder="https://github.com/owner/repo 或 /tree/main/sources"
            />
          </label>
          <button type="button" className="ghost-button" disabled={!url.trim()} onClick={applyUrl}>
            解析链接
          </button>
        </div>
        {parseError ? <p className="field-error">{parseError}</p> : null}
        {parsedUrl ? (
          <div className="repo-url-preview">
            <span className="muted">解析结果</span>
            <strong>{parsedUrl.repo}</strong>
            <span className="chip">分支 {parsedUrl.branch}</span>
            <span className="chip">
              {parsedUrl.pathPrefixes.length ? `路径 ${parsedUrl.pathPrefixes.join('、')}` : '全仓库'}
            </span>
            <span className="muted">已填入下方表单，请核对后点「添加仓库」</span>
          </div>
        ) : null}
        <div className="run-form">
          <label className="field">
            <span>仓库（owner/repo）</span>
            <input
              value={repo}
              onChange={(event) => {
                setRepo(event.target.value);
                setParsedUrl(null);
              }}
              placeholder="owner/lx-music-source"
            />
          </label>
          <label className="field compact">
            <span>分支</span>
            <input
              value={branch}
              onChange={(event) => {
                setBranch(event.target.value);
                setParsedUrl(null);
              }}
              placeholder="main"
            />
          </label>
          <label className="field">
            <span>路径前缀（可选，逗号或换行分隔）</span>
            <input
              value={prefixes}
              onChange={(event) => {
                setPrefixes(event.target.value);
                setParsedUrl(null);
              }}
              placeholder="sources/, kulao/"
            />
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
