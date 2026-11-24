import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  api,
  type AliasView,
  type DuplicateEntryView,
  type DuplicateGroup,
  type DuplicateOverview,
} from '../api';
import { EmptyBox, ErrorBox, Spinner } from '../components/Feedback';

function shortSha(value: string): string {
  return value ? `${value.slice(0, 12)}…` : '—';
}

function shortUrl(value: string): string {
  try {
    const url = new URL(value);
    const path = url.pathname.length > 40 ? `${url.pathname.slice(0, 40)}…` : url.pathname;
    return `${url.host}${path}`;
  } catch {
    return value;
  }
}

function time(value: string): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function entryState(entry: DuplicateEntryView, group: DuplicateGroup): { label: string; tone: string } {
  if (entry.url === group.canonical.url) return { label: '主源', tone: 'ok' };
  if (entry.kind === 'candidate' && entry.state === 'duplicate') return { label: '候选重复', tone: 'warn' };
  if (entry.kind === 'candidate' && !entry.enabled) return { label: '候选', tone: 'idle' };
  if (!entry.enabled) return { label: '已停用', tone: 'idle' };
  if (group.merged) return { label: '已合并', tone: 'ok' };
  return { label: '待合并', tone: 'warn' };
}

export function DuplicatesPage() {
  const [overview, setOverview] = useState<DuplicateOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setOverview(await api.duplicates());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '读取重复与别名失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function merge(group: DuplicateGroup) {
    const duplicates = group.entries
      .filter((entry) => entry.url !== group.canonical.url)
      .map((entry) => ({ url: entry.url, sourceId: entry.id }));
    if (duplicates.length === 0) return;
    setBusy(group.sha256);
    setMessage(null);
    try {
      const result = await api.mergeDuplicates(group.canonical.id, duplicates);
      setMessage(
        `已合并到 ${result.canonicalId}：新增镜像 ${result.addedMirrors.length} 个，别名 ${result.aliases.length} 个，` +
          `停用 ${result.disabled.length} 个，候选标记重复 ${result.candidatesMarked.length} 个。`,
      );
      await load();
    } catch (err) {
      setMessage(err instanceof ApiError ? `合并失败：${err.message}` : '合并失败');
    } finally {
      setBusy(null);
    }
  }

  async function toggleAlias(alias: AliasView) {
    const next = alias.state === 'active' ? 'ignored' : 'active';
    setBusy(alias.url);
    setMessage(null);
    try {
      if (next === 'ignored') await api.ignoreAlias(alias.url);
      else await api.restoreAlias(alias.url);
      await load();
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : '更新别名失败');
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return (
      <div className="boot">
        <Spinner /> 正在读取重复与别名…
      </div>
    );
  }
  if (error) return <ErrorBox message={error} onRetry={() => void load()} />;
  if (!overview) return <EmptyBox message="暂无重复数据" />;

  const { groups, similar, aliases, counts } = overview;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <p className="eyebrow">DUPLICATES</p>
          <h1>重复与别名</h1>
          <p className="muted">
            内容指纹相同的音源只保留一个主源：重复地址变成别名和镜像，重复源停用但保留记录；同名不同内容只提示。
          </p>
        </div>
      </div>

      <div className="stats-grid">
        <div className="stat-card">
          <span className="stat-label">重复组</span>
          <strong className="stat-value">{counts.groups}</strong>
        </div>
        <div className="stat-card">
          <span className="stat-label">重复地址</span>
          <strong className="stat-value">{counts.duplicateUrls}</strong>
          <span className="stat-hint">已合并 {counts.mergedUrls}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">别名</span>
          <strong className="stat-value">{counts.aliases}</strong>
        </div>
        <div className="stat-card">
          <span className="stat-label">同名疑似</span>
          <strong className="stat-value">{counts.similar}</strong>
        </div>
      </div>

      {message ? <div className="notice">{message}</div> : null}

      <section className="panel">
        <div className="panel-head">
          <h2>内容重复</h2>
          <span className="muted">按完整 sha256 分组，只显示至少两个不同地址的组</span>
        </div>
        {groups.length === 0 ? (
          <EmptyBox message="目前没有内容重复的音源" />
        ) : (
          <div className="dup-list">
            {groups.map((group) => {
              const canMerge = group.canonical.kind === 'registry' && !group.merged;
              return (
                <article className="dup-group" key={group.sha256}>
                  <header className="dup-head">
                    <div>
                      <span className="dup-sha" title={group.sha256}>
                        {shortSha(group.sha256)}
                      </span>
                      <strong>{group.canonical.title}</strong>
                      <span className="muted"> · {shortUrl(group.canonical.url)}</span>
                    </div>
                    <div className="row-actions">
                      <span className={`pill ${group.merged ? 'tone-ok' : 'tone-warn'}`}>
                        {group.merged ? '已合并' : '待合并'}
                      </span>
                      <button
                        className="ghost-button"
                        disabled={!canMerge || busy === group.sha256}
                        title={
                          group.canonical.kind !== 'registry'
                            ? '主源还是候选，先在候选页收录'
                            : group.merged
                              ? '已经全部合并'
                              : '把重复地址并入主源'
                        }
                        onClick={() => void merge(group)}
                      >
                        {busy === group.sha256 ? '合并中…' : '合并到主源'}
                      </button>
                    </div>
                  </header>
                  <div className="table-wrap">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>来源</th>
                          <th>地址</th>
                          <th>状态</th>
                          <th>版本</th>
                          <th>首次发现</th>
                        </tr>
                      </thead>
                      <tbody>
                        {group.entries.map((entry) => {
                          const state = entryState(entry, group);
                          return (
                            <tr key={`${entry.kind}:${entry.id}`}>
                              <td>
                                <span className="mini-chip">{entry.kind === 'registry' ? '音源' : '候选'}</span>
                                <span className="muted"> {entry.title}</span>
                              </td>
                              <td className="mono" title={entry.url}>
                                {shortUrl(entry.url)}
                              </td>
                              <td>
                                <span className={`pill tone-${state.tone}`}>{state.label}</span>
                              </td>
                              <td>{entry.version || '—'}</td>
                              <td>{time(entry.firstSeen)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      {similar.length > 0 ? (
        <section className="panel">
          <div className="panel-head">
            <h2>同名疑似（仅提示）</h2>
            <span className="muted">名称和作者相同但内容指纹不同，按你的规则不自动合并</span>
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>名称</th>
                  <th>作者</th>
                  <th>地址</th>
                  <th>sha256</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {similar.flatMap((group) =>
                  group.entries.map((entry) => (
                    <tr key={`similar:${entry.id}`}>
                      <td>{group.title}</td>
                      <td>{group.author}</td>
                      <td className="mono" title={entry.url}>
                        {shortUrl(entry.url)}
                      </td>
                      <td className="mono">{shortSha(entry.sha256 ?? '')}</td>
                      <td>
                        <span className="mini-chip">{entry.state || '候选'}</span>
                      </td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <section className="panel">
        <div className="panel-head">
          <h2>别名</h2>
          <span className="muted">忽略后不再计入重复，但记录保留</span>
        </div>
        {aliases.length === 0 ? (
          <EmptyBox message="还没有别名记录" />
        ) : (
          <div className="table-wrap">
            <table className="data-table alias-table">
              <thead>
                <tr>
                  <th>别名地址</th>
                  <th>主源</th>
                  <th>来源</th>
                  <th>状态</th>
                  <th>更新时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {aliases.map((alias) => (
                  <tr key={alias.url} className={alias.state === 'ignored' ? 'row-disabled' : undefined}>
                    <td className="mono" title={alias.url}>
                      {shortUrl(alias.url)}
                    </td>
                    <td>
                      {alias.canonicalTitle}
                      <span className="muted"> · {alias.canonicalSourceId}</span>
                    </td>
                    <td>{alias.source}</td>
                    <td>
                      <span className={`pill tone-${alias.state === 'active' ? 'ok' : 'idle'}`}>
                        {alias.state === 'active' ? '生效' : '忽略'}
                      </span>
                    </td>
                    <td>{time(alias.updatedAt)}</td>
                    <td>
                      <button
                        className="link-button"
                        disabled={busy === alias.url}
                        onClick={() => void toggleAlias(alias)}
                      >
                        {alias.state === 'active' ? '忽略' : '恢复'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
