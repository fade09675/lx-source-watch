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
import { Pagination, useClientPager } from '../components/Pagination';
import { PageHeader, SectionCard, StatCard, StatGrid } from '../components/ui';

function shortSha(value: string): string {
  return value ? `${value.slice(0, 12)}…` : '—';
}

function shortUrl(value: string): string {
  try {
    const url = new URL(value);
    const decoded = decodeURIComponent(url.pathname);
    const path = decoded.length > 40 ? `${decoded.slice(0, 40)}…` : decoded;
    return `${url.host}${path}`;
  } catch {
    return value;
  }
}

function candidateStateLabel(value: string | null | undefined): string {
  const labels: Record<string, string> = {
    promoted: '已收录',
    qualified: '可收录',
    new: '待验证',
    duplicate: '重复',
    rejected: '已拒绝',
    ignored: '已忽略',
    enabled: '启用中',
    disabled: '已停用',
  };
  return labels[value ?? ''] ?? value ?? '候选';
}

function time(value: string): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function entryState(entry: DuplicateEntryView, group: DuplicateGroup): { label: string; tone: string } {
  if (entry.url === group.canonical.url) {
    return { label: entry.kind === 'candidate' ? '候选主记录' : '主源', tone: 'ok' };
  }
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
  const groupsPager = useClientPager(overview?.groups ?? []);
  const aliasesPager = useClientPager(overview?.aliases ?? []);

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

  async function disableVersion(entry: DuplicateEntryView) {
    const label = entry.kind === 'registry' ? '停用这个音源版本' : '停用这个候选版本';
    if (!window.confirm(`${label}？\n\n${entry.url}\n\n不会删除记录，之后可以在对应页面恢复。`)) return;
    const busyKey = `${entry.kind}:${entry.id}`;
    setBusy(busyKey);
    setMessage(null);
    try {
      await api.disableDuplicateVersion(entry.kind, entry.id);
      setMessage('已停用该版本。');
      await load();
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : '停用版本失败');
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
      <PageHeader
        eyebrow="DUPLICATES"
        title="重复与别名"
        description="内容指纹相同的音源只保留一个主源：重复地址变成别名和镜像，重复源停用但保留记录；同名不同内容按版本并列，可手动停用不需要的版本。"
      />

      <StatGrid compact>
        <StatCard label="重复组" value={counts.groups} hint="按完整 sha256 分组" />
        <StatCard label="重复地址" value={counts.duplicateUrls} hint={`已合并 ${counts.mergedUrls}`} />
        <StatCard label="别名" value={counts.aliases} hint="忽略后仍保留记录" />
        <StatCard label="同名多版本" value={counts.similar} hint="仅提示，可手动停用" tone="warn" />
      </StatGrid>

      {message ? <div className="notice">{message}</div> : null}

      <SectionCard
        title="内容重复"
        description="按完整 sha256 分组，只显示至少两个不同地址的组"
        actions={<span className="muted small">{counts.groups} 组</span>}
      >
        {groups.length === 0 ? (
          <EmptyBox message="目前没有内容重复的音源" />
        ) : (
          <div className="dup-list">
            {groupsPager.pageItems.map((group) => {
              const canMerge = group.canonical.kind === 'registry' && !group.merged;
              return (
                <article className="dup-group" key={group.sha256}>
                  <header className="dup-head">
                    <div className="dup-title">
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
                      {!canMerge && !group.merged && (
                        <span className="muted small">主记录是候选，先收录为正式源</span>
                      )}
                      <button
                        className="row-link"
                        disabled={!canMerge || busy === group.sha256}
                        title={
                          group.canonical.kind !== 'registry'
                            ? '主记录还是候选，先在候选页收录'
                            : group.merged
                              ? '已经全部合并'
                              : '把重复地址并入主记录'
                        }
                        onClick={() => void merge(group)}
                      >
                        {busy === group.sha256 ? '合并中…' : '合并到主记录'}
                      </button>
                    </div>
                  </header>
                  <div className="dup-entries">
                    {group.entries.map((entry) => {
                      const state = entryState(entry, group);
                      return (
                        <div className="dup-entry" key={`${entry.kind}:${entry.id}`}>
                          <span className="mini-chip">{entry.kind === 'registry' ? '音源' : '候选'}</span>
                          <div className="dup-entry-main">
                            <strong>{entry.title}</strong>
                            <span className="mono" title={entry.url}>
                              {shortUrl(entry.url)}
                            </span>
                          </div>
                          <span className="dup-entry-meta">{entry.version || '—'}</span>
                          <span className="dup-entry-meta">{time(entry.firstSeen)}</span>
                          <span className={`pill tone-${state.tone}`}>{state.label}</span>
                        </div>
                      );
                    })}
                  </div>
                </article>
              );
            })}
          </div>
        )}
        {groups.length > 0 && <Pagination {...groupsPager.pagination} label="个重复组" />}
      </SectionCard>

      {similar.length > 0 ? (
        <SectionCard
          title="同名多版本"
          description="名称和作者相同但内容指纹不同；按版本并列，可手动停用不需要的版本，不自动合并"
          actions={<span className="muted small">{counts.similar} 组</span>}
        >
          <div className="table-wrap">
            <table className="data-table responsive-table">
              <thead>
                <tr>
                  <th>名称</th>
                  <th>作者</th>
                  <th>地址</th>
                  <th>版本</th>
                  <th>sha256</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {similar.flatMap((group) =>
                  group.entries.map((entry) => {
                    const busyKey = `${entry.kind}:${entry.id}`;
                    const disabled = entry.kind === 'registry' ? !entry.enabled : entry.state === 'rejected';
                    return (
                      <tr key={`similar:${entry.kind}:${entry.id}`} className={disabled ? 'row-disabled' : undefined}>
                        <td data-label="名称">{group.title}</td>
                        <td data-label="作者">{group.author}</td>
                        <td className="mono" title={entry.url} data-label="地址">
                          {shortUrl(entry.url)}
                        </td>
                        <td data-label="版本">{entry.version || '—'}</td>
                        <td className="mono" data-label="sha256">{shortSha(entry.sha256 ?? '')}</td>
                        <td data-label="状态">
                          <span className="mini-chip">{candidateStateLabel(entry.state)}</span>
                        </td>
                        <td className="row-actions" data-label="">
                          <button
                            className="link-button"
                            disabled={disabled || busy === busyKey}
                            onClick={() => void disableVersion(entry)}
                          >
                            {disabled ? '已停用' : busy === busyKey ? '处理中…' : '停用'}
                          </button>
                        </td>
                      </tr>
                    );
                  }),
                )}
              </tbody>
            </table>
          </div>
        </SectionCard>
      ) : null}

      <SectionCard
        title="别名"
        description="忽略后不再计入重复，但记录保留"
        actions={<span className="muted small">{counts.aliases} 条</span>}
      >
        {aliases.length === 0 ? (
          <EmptyBox message="还没有别名记录" />
        ) : (
          <div className="table-wrap">
            <table className="data-table alias-table responsive-table">
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
                {aliasesPager.pageItems.map((alias) => (
                  <tr key={alias.url} className={alias.state === 'ignored' ? 'row-disabled' : undefined}>
                    <td className="mono" title={alias.url} data-label="别名地址">
                      {shortUrl(alias.url)}
                    </td>
                    <td data-label="主源">
                      {alias.canonicalTitle}
                      <span className="muted"> · {alias.canonicalSourceId}</span>
                    </td>
                    <td data-label="来源">{alias.source}</td>
                    <td data-label="状态">
                      <span className={`pill tone-${alias.state === 'active' ? 'ok' : 'idle'}`}>
                        {alias.state === 'active' ? '生效' : '忽略'}
                      </span>
                    </td>
                    <td data-label="更新时间">{time(alias.updatedAt)}</td>
                    <td className="row-actions" data-label="">
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
        {aliases.length > 0 && <Pagination {...aliasesPager.pagination} label="条别名" />}
      </SectionCard>
    </div>
  );
}
