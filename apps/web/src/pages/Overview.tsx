import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  PLATFORMS,
  STATUS_META,
  formatDateTime,
  formatDuration,
  formatMs,
  sortPlatformKeys,
  type SourceStatus,
  type StatusEnvelope,
} from '@lx/shared';
import { ApiError, api, type StatusFilters } from '../api';
import { EmptyBox, ErrorBox, Spinner } from '../components/Feedback';
import { PlatformChip } from '../components/PlatformChip';
import { StatusBadge } from '../components/StatusBadge';

const STATUS_ORDER: SourceStatus[] = ['available', 'partial', 'unavailable', 'untested'];

export function OverviewPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<StatusEnvelope | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState(params.get('q') ?? '');

  const platforms = useMemo(() => (params.get('platform') ?? '').split(',').filter(Boolean), [params]);
  const statuses = useMemo(() => (params.get('status') ?? '').split(',').filter(Boolean), [params]);
  const q = params.get('q') ?? '';

  const filters: StatusFilters = useMemo(
    () => ({ platforms: platforms.length ? platforms : undefined, statuses: statuses.length ? statuses : undefined, q: q || undefined }),
    [platforms, statuses, q],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    api
      .status(filters)
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : '加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filters]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (query === q) return;
      const next = new URLSearchParams(params);
      if (query) next.set('q', query);
      else next.delete('q');
      setParams(next, { replace: true });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [query, q, params, setParams]);

  function togglePlatform(key: string) {
    const next = new URLSearchParams(params);
    const current = new Set(platforms);
    if (current.has(key)) current.delete(key);
    else current.add(key);
    if (current.size) next.set('platform', [...current].join(','));
    else next.delete('platform');
    setParams(next, { replace: true });
  }

  function toggleStatus(key: SourceStatus) {
    const next = new URLSearchParams(params);
    const current = new Set(statuses);
    if (current.has(key)) current.delete(key);
    else current.add(key);
    if (current.size) next.set('status', [...current].join(','));
    else next.delete('status');
    setParams(next, { replace: true });
  }

  function clearFilters() {
    setQuery('');
    setParams(new URLSearchParams(), { replace: true });
  }

  const snapshot = data?.snapshot;
  const summary = snapshot?.summary;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>音源总览</h1>
          <p className="muted">
            {snapshot ? (
              <>
                生成于 {formatDateTime(snapshot.generatedAt)} · 用时 {formatDuration(snapshot.durationMs)} · 下一轮 {formatDateTime(snapshot.nextCheckAt)}
                {data?.stale && <span className="pill pill-warn">已过期</span>}
              </>
            ) : (
              '正在获取最新一轮结果'
            )}
          </p>
        </div>
        <div className="page-actions">
          <button type="button" className="ghost-button" onClick={() => void loadAgain()} disabled={loading}>
            刷新
          </button>
        </div>
      </div>

      {summary && (
        <div className="stats-grid">
          <StatCard label="音源总数" value={summary.total} tone="idle" />
          <StatCard label="可用" value={summary.available} tone="ok" />
          <StatCard label="部分可用" value={summary.partial} tone="warn" />
          <StatCard label="不可用" value={summary.unavailable} tone="bad" />
          <StatCard label="未测试" value={summary.untested} tone="idle" />
          <StatCard label="通过平台" value={`${summary.platformsOk}/${summary.platformsTested}`} tone="ok" />
        </div>
      )}

      <div className="filter-bar">
        <input
          className="search-input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索名称 / 作者 / 描述"
        />
        <div className="filter-group">
          <span className="filter-label">状态</span>
          {STATUS_ORDER.map((key) => (
            <button
              key={key}
              type="button"
              className={`filter-chip${statuses.includes(key) ? ' active' : ''}`}
              onClick={() => toggleStatus(key)}
            >
              {STATUS_META[key].label}
            </button>
          ))}
        </div>
        <div className="filter-group">
          <span className="filter-label">平台</span>
          {PLATFORMS.filter((item) => item.testable).map((item) => (
            <button
              key={item.key}
              type="button"
              className={`filter-chip${platforms.includes(item.key) ? ' active' : ''}`}
              onClick={() => togglePlatform(item.key)}
              title={`只看声明了 ${item.name} 的音源`}
            >
              {item.short}
            </button>
          ))}
        </div>
        {(platforms.length > 0 || statuses.length > 0 || q) && (
          <button type="button" className="link-button" onClick={clearFilters}>
            清空筛选
          </button>
        )}
      </div>

      {loading && !snapshot && <Spinner label="正在加载监测结果…" />}
      {error && <ErrorBox message={error} onRetry={() => setParams(new URLSearchParams(params), { replace: true })} />}
      {snapshot && snapshot.sources.length === 0 && <EmptyBox message="没有符合筛选条件的音源。" />}

      {snapshot && snapshot.sources.length > 0 && (
        <div className="matrix-wrap">
          <table className="matrix">
            <thead>
              <tr>
                <th className="col-source">音源</th>
                <th className="col-status">状态</th>
                <th className="col-platforms">平台（通过 / 已测）</th>
                <th className="col-count">通过</th>
                <th className="col-duration">耗时</th>
              </tr>
            </thead>
            <tbody>
              {[...snapshot.sources]
                .sort((a, b) => b.stats.ok - a.stats.ok || a.title.localeCompare(b.title, 'zh-CN'))
                .map((source) => {
                  const keys = sortPlatformKeys(source.platforms.filter((item) => item.declared).map((item) => item.key));
                  const byKey = new Map(source.platforms.map((item) => [item.key, item]));
                  const endpointsOk = source.endpoints.filter((item) => item.ok).length;
                  const lagging = source.endpoints.some((item) => item.versionState === 'lagging');
                  return (
                    <tr key={source.id} onClick={() => navigate(`/s/${encodeURIComponent(source.id)}`)} className="matrix-row">
                      <td>
                        <div className="source-title">{source.title}</div>
                        <div className="source-sub">
                          <span className="mono">{source.id}</span>
                          {source.version && <span>v{source.version}</span>}
                          {source.author && <span>{source.author}</span>}
                          {source.endpoints.length > 0 && (
                            <span className={endpointsOk > 0 ? 'text-ok' : 'text-bad'}>
                              接入点 {endpointsOk}/{source.endpoints.length}
                            </span>
                          )}
                          {lagging && <span className="pill pill-warn">镜像版本落后</span>}
                        </div>
                      </td>
                      <td>
                        <StatusBadge status={source.status} />
                        {!source.initOk && <div className="source-error">初始化：{source.initError ?? '失败'}</div>}
                      </td>
                      <td>
                        <div className="platform-grid">
                          {keys.map((key) => {
                            const platform = byKey.get(key);
                            return platform ? <PlatformChip key={key} platform={platform} /> : null;
                          })}
                          {keys.length === 0 && <span className="muted">未声明平台</span>}
                        </div>
                      </td>
                      <td className="mono count-cell">
                        <strong>{source.stats.ok}</strong>/{source.stats.tested}
                        <span className="muted"> / {source.stats.total}</span>
                      </td>
                      <td className="mono muted">{formatMs(source.durationMs)}</td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );

  function loadAgain() {
    setParams(new URLSearchParams(params), { replace: true });
  }
}

function StatCard({ label, value, tone }: { label: string; value: number | string; tone: 'ok' | 'warn' | 'bad' | 'idle' }) {
  return (
    <div className={`stat-card tone-${tone}`}>
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}
