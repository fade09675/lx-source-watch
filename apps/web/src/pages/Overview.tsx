import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  PLATFORMS,
  QUALITY_META,
  STATUS_META,
  assessSourceQuality,
  formatDateTime,
  formatDuration,
  formatMs,
  platformMeta,
  sortPlatformKeys,
  type SourceQuality,
  type SourceResult,
  type SourceStatus,
  type StatusEnvelope,
} from '@lx/shared';
import { ApiError, api, type StatusFilters } from '../api';
import { EmptyBox, ErrorBox, Spinner } from '../components/Feedback';
import { Icon } from '../components/Icon';
import { Pagination, useClientPager } from '../components/Pagination';
import { PlatformChip } from '../components/PlatformChip';
import { StatusBadge } from '../components/StatusBadge';
import { hostOf, pickRecommended } from '../lib/endpoints';
import { humanizeError } from '../lib/errors';

const STATUS_ORDER: SourceStatus[] = ['available', 'partial', 'unavailable', 'untested'];

export function OverviewPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<StatusEnvelope | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState(params.get('q') ?? '');
  const [view, setView] = useState<'grid' | 'list'>(
    () => (window.localStorage.getItem('lx-sources-view') === 'list' ? 'list' : 'grid'),
  );
  const [copiedId, setCopiedId] = useState('');

  const platforms = useMemo(() => (params.get('platform') ?? '').split(',').filter(Boolean), [params]);
  const statuses = useMemo(() => (params.get('status') ?? '').split(',').filter(Boolean), [params]);
  const cn = params.get('cn') ?? '';
  const q = params.get('q') ?? '';
  const qualityMode: 'all' | 'recommended' | 'available' =
    params.get('quality') === 'recommended'
      ? 'recommended'
      : params.get('quality') === 'available'
        ? 'available'
        : 'all';

  const filters: StatusFilters = useMemo(
    () => ({
      platforms: platforms.length ? platforms : undefined,
      statuses: statuses.length ? statuses : undefined,
      cn: cn || undefined,
      q: q || undefined,
    }),
    [platforms, statuses, cn, q],
  );

  const qualityById = useMemo(
    () =>
      new Map(
        (data?.snapshot.sources ?? []).map((source) => [source.id, assessSourceQuality(source)] as const),
      ),
    [data],
  );

  const sortedSources = useMemo(() => {
    const sources = (data?.snapshot.sources ?? []).filter((source) => {
      const quality = qualityById.get(source.id);
      if (qualityMode === 'recommended') return Boolean(quality?.recommended);
      if (qualityMode === 'available') return source.status === 'available';
      return true;
    });
    return sources.sort((a, b) => {
      const scoreA = qualityById.get(a.id)?.score ?? 0;
      const scoreB = qualityById.get(b.id)?.score ?? 0;
      return scoreB - scoreA || b.stats.ok - a.stats.ok || a.title.localeCompare(b.title, 'zh-CN');
    });
  }, [data, qualityById, qualityMode]);
  const pager = useClientPager(sortedSources);

  useEffect(() => {
    pager.reset();
  }, [params, pager.reset]);

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

  function toggleCnFailed() {
    const next = new URLSearchParams(params);
    if (cn === 'failed') next.delete('cn');
    else next.set('cn', 'failed');
    setParams(next, { replace: true });
  }

  function changeQualityMode(mode: 'all' | 'recommended' | 'available') {
    const next = new URLSearchParams(params);
    if (mode === 'all') next.delete('quality');
    else next.set('quality', mode);
    setParams(next, { replace: true });
  }

  function clearFilters() {
    setQuery('');
    setParams(new URLSearchParams(), { replace: true });
  }

  function changeView(next: 'grid' | 'list') {
    setView(next);
    window.localStorage.setItem('lx-sources-view', next);
  }

  async function copySource(source: SourceResult) {
    const recommended = pickRecommended(source.endpoints, source.url);
    try {
      await navigator.clipboard.writeText(recommended.url);
      setCopiedId(source.id);
      window.setTimeout(() => setCopiedId(''), 1600);
    } catch {
      setCopiedId('');
    }
  }

  const snapshot = data?.snapshot;
  const summary = snapshot?.summary;
  const cnStats = useMemo(() => {
    let tested = 0;
    let ok = 0;
    for (const source of snapshot?.sources ?? []) {
      for (const platform of source.platforms) {
        if (!platform.declared || !platform.cn?.tested) continue;
        tested += 1;
        if (platform.cn.ok) ok += 1;
      }
    }
    return { tested, ok };
  }, [snapshot]);

  return (
    <div className="page sources-page">
      <div className="page-head">
        <div>
          <h1>音源总览</h1>
          <p className="muted">
            {snapshot ? (
              <>
                生成于 {formatDateTime(snapshot.generatedAt)} · 用时 {formatDuration(snapshot.durationMs)} · 下一轮{' '}
                {formatDateTime(snapshot.nextCheckAt)}
                {data?.stale && <span className="pill pill-warn">已过期</span>}
              </>
            ) : (
              '正在获取最新一轮结果'
            )}
          </p>
        </div>
        <div className="page-actions">
          <button type="button" className="ghost-button" onClick={loadAgain} disabled={loading}>
            <Icon name="refresh" size={14} />
            刷新
          </button>
        </div>
      </div>

      {summary && (
        <div className="stats-grid source-stats">
          <StatCard label="音源总数" value={summary.total} tone="idle" />
          <StatCard label="可用" value={summary.available} tone="ok" />
          <StatCard label="部分可用" value={summary.partial} tone="warn" />
          <StatCard label="不可用" value={summary.unavailable} tone="bad" />
          <StatCard label="未测试" value={summary.untested} tone="idle" />
          <StatCard label="通过平台" value={`${summary.platformsOk}/${summary.platformsTested}`} tone="ok" />
          <StatCard
            label="国内可达平台"
            value={cnStats.tested > 0 ? `${cnStats.ok}/${cnStats.tested}` : '未测'}
            tone={
              cnStats.tested === 0
                ? 'idle'
                : cnStats.ok === cnStats.tested
                  ? 'ok'
                  : cnStats.ok > 0
                    ? 'warn'
                    : 'bad'
            }
            hint={cnStats.tested === 0 ? '海外全通过的平台不再补测，未测不等于不可用' : '经国内代理补测可达 / 已补测平台'}
          />
        </div>
      )}

      <div className="filter-bar source-filter-bar">
        <input
          className="search-input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索名称 / 作者 / 描述"
        />
        <div className="filter-group">
          <span className="filter-label">范围</span>
          <button
            type="button"
            className={`filter-chip${qualityMode === 'recommended' ? ' active' : ''}`}
            onClick={() => changeQualityMode('recommended')}
            title="平台与接入点通过率达标、结果新鲜且无国内全失败"
          >
            推荐
          </button>
          <button
            type="button"
            className={`filter-chip${qualityMode === 'available' ? ' active' : ''}`}
            onClick={() => changeQualityMode('available')}
            title="只看本轮全部声明平台都通过的音源"
          >
            可用
          </button>
          <button
            type="button"
            className={`filter-chip${qualityMode === 'all' ? ' active' : ''}`}
            onClick={() => changeQualityMode('all')}
          >
            全部
          </button>
        </div>
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
        <div className="filter-group">
          <span className="filter-label">国内</span>
          <button
            type="button"
            className={`filter-chip${cn === 'failed' ? ' active' : ''}`}
            onClick={toggleCnFailed}
            title="只看至少一个平台经国内代理补测失败的音源"
          >
            只看国内失败
          </button>
        </div>
        {(platforms.length > 0 || statuses.length > 0 || cn || q || qualityMode !== 'all') && (
          <button type="button" className="link-button" onClick={clearFilters}>
            清空筛选
          </button>
        )}
        <div className="view-toggle" role="group" aria-label="视图">
          <button
            type="button"
            className={view === 'grid' ? 'active' : ''}
            onClick={() => changeView('grid')}
            title="卡片视图"
          >
            <Icon name="grid" size={14} />
            卡片
          </button>
          <button
            type="button"
            className={view === 'list' ? 'active' : ''}
            onClick={() => changeView('list')}
            title="列表视图"
          >
            <Icon name="list" size={14} />
            列表
          </button>
        </div>
      </div>

      {loading && !snapshot && <Spinner label="正在加载监测结果…" />}
      {error && <ErrorBox message={error} onRetry={loadAgain} />}
      {snapshot && sortedSources.length === 0 && (
        <EmptyBox
          message={
            qualityMode === 'recommended'
              ? '当前没有推荐音源，可切换到「可用」或「全部」查看。'
              : qualityMode === 'available'
                ? '当前没有全部平台都通过的音源，可切换到「推荐」或「全部」。'
                : '没有符合筛选条件的音源。'
          }
        />
      )}

      {snapshot && sortedSources.length > 0 && view === 'grid' && (
        <div className="source-grid">
          {pager.pageItems.map((source) => (
            <SourceCard
              key={source.id}
              source={source}
              quality={qualityById.get(source.id)}
              copied={copiedId === source.id}
              onCopy={() => void copySource(source)}
            />
          ))}
        </div>
      )}

      {snapshot && sortedSources.length > 0 && view === 'list' && (
        <div className="matrix-wrap">
          <table className="matrix">
            <thead>
              <tr>
                <th className="col-source">音源</th>
                <th className="col-status">状态</th>
                <th className="col-quality">质量</th>
                <th className="col-platforms">平台（通过 / 已测）</th>
                <th className="col-count">通过</th>
                <th className="col-duration">耗时</th>
              </tr>
            </thead>
            <tbody>
              {pager.pageItems.map((source) => {
                const keys = sortPlatformKeys(source.platforms.filter((item) => item.declared).map((item) => item.key));
                const byKey = new Map(source.platforms.map((item) => [item.key, item]));
                const endpointsOk = source.endpoints.filter((item) => item.ok).length;
                const lagging = source.endpoints.some((item) => item.versionState === 'lagging');
                const cnPlatforms = source.platforms.filter((item) => item.declared && item.cn?.tested);
                const cnOk = cnPlatforms.filter((item) => item.cn?.ok).length;
                const originLabel = source.origin || hostOf(source.homepage || source.url);
                return (
                  <tr
                    key={source.id}
                    onClick={() => navigate(`/s/${encodeURIComponent(source.id)}`)}
                    className="matrix-row"
                  >
                    <td>
                      <div className="source-title">{source.title}</div>
                      <div className="source-sub">
                        <span className="mono">{source.id}</span>
                        {source.version && <span>v{source.version}</span>}
                        {source.author && <span>{source.author}</span>}
                        {originLabel && (
                          <span className="source-origin" title={source.origin || source.homepage || source.url}>
                            来源 {originLabel}
                          </span>
                        )}
                        {source.endpoints.length > 0 && (
                          <span
                            className={endpointsOk > 0 ? 'text-ok' : 'text-bad'}
                            title={`接入点 ${endpointsOk}/${source.endpoints.length}：主地址与镜像中 ${source.endpoints.length} 个地址，本轮 ${endpointsOk} 个下载成功`}
                          >
                            接入点 {endpointsOk}/{source.endpoints.length}
                          </span>
                        )}
                        {source.via && (
                          <span
                            className={`pill tone-${source.via === 'primary' ? 'ok' : 'warn'}`}
                            title={source.chosenUrl ? `本轮实际加载：${source.chosenUrl}` : '本轮实际加载的接入点'}
                          >
                            本轮 {source.via === 'primary' ? '主地址' : '镜像'}
                          </span>
                        )}
                        {lagging && <span className="pill pill-warn">镜像版本落后</span>}
                        {cnPlatforms.length > 0 && (
                          <span
                            className={`pill tone-${
                              cnOk === cnPlatforms.length ? 'ok' : cnOk > 0 ? 'warn' : 'bad'
                            }`}
                            title="经国内代理补测可达的平台数 / 已补测平台数"
                          >
                            国内 {cnOk}/{cnPlatforms.length}
                          </span>
                        )}
                      </div>
                    </td>
                    <td>
                      <StatusBadge status={source.status} />
                      {!source.initOk && <div className="source-error">初始化：{source.initError ?? '失败'}</div>}
                    </td>
                    <td>
                      {(() => {
                        const quality = qualityById.get(source.id);
                        if (!quality) return <span className="muted">—</span>;
                        const meta = QUALITY_META[quality.tier];
                        return (
                          <span
                            className={`quality-score tone-${meta.tone}`}
                            title={quality.reasons.join('；')}
                          >
                            {quality.score}
                            <span className="quality-score-label">{meta.label}</span>
                          </span>
                        );
                      })()}
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

      {snapshot && sortedSources.length > 0 && <Pagination {...pager.pagination} label="个音源" />}
    </div>
  );

  function loadAgain() {
    setParams(new URLSearchParams(params), { replace: true });
  }
}

function SourceCard({
  source,
  quality,
  copied,
  onCopy,
}: {
  source: SourceResult;
  quality?: SourceQuality;
  copied: boolean;
  onCopy: () => void;
}) {
  const declared = sortPlatformKeys(source.platforms.filter((item) => item.declared).map((item) => item.key));
  const byKey = new Map(source.platforms.map((item) => [item.key, item]));
  const endpointsOk = source.endpoints.filter((item) => item.ok).length;
  const cnPlatforms = source.platforms.filter((item) => item.declared && item.cn?.tested);
  const cnOk = cnPlatforms.filter((item) => item.cn?.ok).length;
  const originLabel = source.origin || hostOf(source.homepage || source.url);
  const issue = sourceIssue(source);
  const lagging = source.endpoints.some((item) => item.versionState === 'lagging');
  const chosen = source.chosenUrl
    ? source.endpoints.find((item) => item.url === source.chosenUrl)
    : undefined;

  return (
    <article className="source-card">
      <div className="source-card-head">
        <div className="source-card-title">
          <div className="source-card-name">
            <Link to={`/s/${encodeURIComponent(source.id)}`}>{source.title}</Link>
            {quality?.recommended && (
              <span className="pill tone-ok" title={quality.reasons.join('；')}>
                推荐
              </span>
            )}
            {source.version && <span className="pill">v{source.version}</span>}
          </div>
          <div className="source-card-meta">
            <span className="mono">{source.id}</span>
            {source.author && <span>{source.author}</span>}
            <span className="source-origin" title={source.origin || source.homepage || source.url}>
              {originLabel}
            </span>
          </div>
        </div>
        <StatusBadge status={source.status} />
      </div>

      <div className="source-card-metrics">
        <div>
          <span>接入点</span>
          <strong className={endpointsOk === source.endpoints.length ? 'text-ok' : 'text-warn'}>
            {endpointsOk}/{source.endpoints.length}
          </strong>
        </div>
        <div>
          <span>平台</span>
          <strong className={source.stats.ok === source.stats.tested ? 'text-ok' : 'text-warn'}>
            {source.stats.ok}/{source.stats.tested}
          </strong>
        </div>
        <div>
          <span>国内</span>
          <strong className={cnPlatforms.length === 0 ? 'muted' : cnOk === cnPlatforms.length ? 'text-ok' : 'text-warn'}>
            {cnPlatforms.length > 0 ? `${cnOk}/${cnPlatforms.length}` : '未测'}
          </strong>
        </div>
        <div>
          <span>耗时</span>
          <strong>{formatMs(source.durationMs)}</strong>
        </div>
      </div>

      <div
        className="source-card-platforms"
        title={declared.length > 0 ? `全部 ${declared.length} 个平台` : undefined}
      >
        {declared.map((key) => {
          const platform = byKey.get(key);
          return platform ? <PlatformChip key={key} platform={platform} /> : null;
        })}
        {declared.length === 0 && <span className="muted small">未声明平台</span>}
      </div>

      <p className={`source-issue tone-${issue.tone}`} title={issue.raw}>
        {issue.text}
      </p>

      <footer className="source-card-foot">
        <span className="source-card-flags">
          {source.via ? (
            <span
              className={`pill tone-${chosen?.ok === false ? 'bad' : source.via === 'primary' ? 'ok' : 'warn'}`}
              title={source.chosenUrl ? `本轮实际加载：${source.chosenUrl}` : undefined}
            >
              本轮使用{source.via === 'primary' ? '主地址' : '镜像'} ·{' '}
              {chosen?.ok === false ? '失败' : formatMs(chosen?.ms)}
            </span>
          ) : (
            <span className="pill tone-idle">本轮入口未记录</span>
          )}
          {lagging && <span className="pill tone-warn">镜像落后</span>}
        </span>
        <span className="source-card-actions">
          <button type="button" className="link-button" onClick={onCopy}>
            {copied ? '已复制推荐地址' : '复制导入地址'}
          </button>
          <Link to={`/s/${encodeURIComponent(source.id)}`} className="link-button">
            详情
            <Icon name="chevron-right" size={12} />
          </Link>
        </span>
      </footer>
    </article>
  );
}

function sourceIssue(source: SourceResult): { tone: 'ok' | 'warn' | 'bad'; text: string; raw?: string } {
  if (!source.initOk) {
    const raw = source.initError ?? '未知原因';
    return { tone: 'bad', text: `初始化失败：${humanizeError(raw)}`, raw };
  }
  const failed = source.platforms.filter((item) => item.declared && item.tested && !item.ok);
  if (failed.length > 0) {
    const first = failed[0];
    if (first) {
      const raw = first.error ?? first.errorKind ?? '未知原因';
      return {
        tone: failed.length === source.stats.tested ? 'bad' : 'warn',
        text: `${failed.length} 个平台未通过 · ${platformMeta(first.key).name}：${humanizeError(raw)}`,
        raw,
      };
    }
  }
  const failedEndpoints = source.endpoints.filter((item) => !item.ok);
  if (failedEndpoints.length > 0) {
    return { tone: 'warn', text: `${failedEndpoints.length} 个接入点下载失败，本轮已切换到可用地址` };
  }
  if (source.status === 'available') {
    return { tone: 'ok', text: '全部平台和接入点通过' };
  }
  return { tone: 'warn', text: '本轮没有需要补测的失败项' };
}

function StatCard({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: number | string;
  tone: 'ok' | 'warn' | 'bad' | 'idle';
  hint?: string;
}) {
  return (
    <div className={`stat-card tone-${tone}`}>
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
      {hint && <span className="stat-hint">{hint}</span>}
    </div>
  );
}
