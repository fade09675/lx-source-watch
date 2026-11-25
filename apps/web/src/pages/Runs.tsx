import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ERROR_LABEL,
  formatDateTime,
  formatDuration,
  formatMs,
  formatRelative,
  platformMeta,
  type ErrorKind,
  type RunSummary,
} from '@lx/shared';
import { ApiError, api, type FailureAggregate, type PlatformSummary } from '../api';
import { ErrorBox, Spinner } from '../components/Feedback';
import { Pagination, useClientPager } from '../components/Pagination';

type TabKey = 'runs' | 'platforms' | 'failures';

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'runs', label: '运行记录' },
  { key: 'platforms', label: '平台汇总' },
  { key: 'failures', label: '失败聚合' },
];

function runTone(run: RunSummary): { label: string; tone: string } {
  if (run.status === 'success') return { label: '成功', tone: 'ok' };
  if (run.status === 'partial') return { label: '部分成功', tone: 'warn' };
  if (run.status === 'failed') return { label: '失败', tone: 'bad' };
  if (run.status === 'running') return { label: '运行中', tone: 'warn' };
  if (run.total === 0) return { label: '空', tone: 'idle' };
  if (run.available === run.total) return { label: '全可用', tone: 'ok' };
  if (run.available === 0 && run.partial === 0 && run.untested === 0) return { label: '不可用', tone: 'bad' };
  if (run.available > 0) return { label: '部分可用', tone: 'warn' };
  return { label: '基本失效', tone: 'bad' };
}

const TRIGGER_LABEL: Record<string, string> = {
  schedule: '定时',
  manual: '手动',
  retry: '重试',
  local: '本地',
};

function triggerLabel(trigger?: string): string {
  if (!trigger) return '—';
  return TRIGGER_LABEL[trigger] ?? trigger;
}

function countPair(ok: number | undefined, total: number | undefined): string {
  if (!total) return '—';
  return `${ok ?? 0}/${total}`;
}

function errorLabel(kind: string | null): string {
  if (!kind) return '未知';
  return ERROR_LABEL[kind as ErrorKind] ?? kind;
}

function rate(failed: number, tested: number): string {
  if (tested <= 0) return '—';
  return `${Math.round((failed / tested) * 100)}%`;
}

export function RunsPage() {
  const [runs, setRuns] = useState<{ runs: RunSummary[]; total: number } | null>(null);
  const [aggregate, setAggregate] = useState<FailureAggregate | null>(null);
  const [platforms, setPlatforms] = useState<PlatformSummary | null>(null);
  const [error, setError] = useState('');
  const [days, setDays] = useState(7);
  const [tab, setTab] = useState<TabKey>('runs');
  const [statusFilter, setStatusFilter] = useState('all');
  const [triggerFilter, setTriggerFilter] = useState('all');
  const [limit, setLimit] = useState(10);
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    setOffset(0);
  }, [days, statusFilter, triggerFilter]);

  useEffect(() => {
    let cancelled = false;
    setError('');
    setAggregate(null);
    setPlatforms(null);
    Promise.all([api.failures(days), api.platforms(days)])
      .then(([failureResult, platformResult]) => {
        if (cancelled) return;
        setAggregate(failureResult);
        setPlatforms(platformResult);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : '加载运行统计失败');
      });
    return () => {
      cancelled = true;
    };
  }, [days]);

  useEffect(() => {
    let cancelled = false;
    setRuns(null);
    api
      .snapshots({
        limit,
        offset,
        days,
        status: statusFilter === 'all' ? undefined : statusFilter,
        trigger: triggerFilter === 'all' ? undefined : triggerFilter,
      })
      .then((result) => {
        if (!cancelled) setRuns({ runs: result.runs, total: result.total });
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : '加载运行记录失败');
      });
    return () => {
      cancelled = true;
    };
  }, [days, statusFilter, triggerFilter, limit, offset]);

  const maxKind = Math.max(1, ...(aggregate?.byKind.map((item) => item.count) ?? [1]));
  const failureRate =
    aggregate && aggregate.platformTests > 0
      ? `${Math.round((aggregate.platformFailures / aggregate.platformTests) * 100)}%`
      : '—';

  const visibleRuns = runs?.runs ?? [];
  const totalRuns = runs?.total ?? 0;

  const platformTotals = useMemo(() => {
    const rows = platforms?.rows ?? [];
    const tested = rows.reduce((sum, row) => sum + row.tested, 0);
    const ok = rows.reduce((sum, row) => sum + row.ok, 0);
    const failed = rows.reduce((sum, row) => sum + row.failed, 0);
    const cnTested = rows.reduce((sum, row) => sum + row.cnTested, 0);
    const cnOk = rows.reduce((sum, row) => sum + row.cnOk, 0);
    return { tested, ok, failed, cnTested, cnOk };
  }, [platforms]);
  const platformPager = useClientPager(platforms?.rows ?? []);
  const failSourcePager = useClientPager(aggregate?.bySource ?? []);
  useEffect(() => {
    platformPager.reset();
    failSourcePager.reset();
  }, [days, platformPager.reset, failSourcePager.reset]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <span className="eyebrow">OPERATIONS</span>
          <h1>运行与日志</h1>
          <p className="muted">每轮探测的结果、接入点、平台与失败原因都汇总在这里。</p>
        </div>
        <div className="segmented">
          {[7, 14, 30].map((value) => (
            <button
              key={value}
              type="button"
              className={value === days ? 'segmented-item active' : 'segmented-item'}
              onClick={() => {
                setDays(value);
                setOffset(0);
              }}
            >
              近 {value} 天
            </button>
          ))}
        </div>
      </div>

      <div className="tabs" role="tablist">
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={tab === item.key}
            className={tab === item.key ? 'tab active' : 'tab'}
            onClick={() => setTab(item.key)}
          >
            {item.label}
            {item.key === 'runs' && runs ? <span className="tab-count">{totalRuns}</span> : null}
            {item.key === 'platforms' && platforms ? <span className="tab-count">{platforms.runCount}</span> : null}
          </button>
        ))}
      </div>

      {error && <ErrorBox message={error} />}

      {tab === 'runs' && (
        <section>
          <div className="panel-head">
            <h2>运行记录</h2>
            <span className="muted">共 {totalRuns} 条</span>
          </div>
          <div className="filter-bar run-filter-bar">
            <label className="select-field">
              <span>状态</span>
              <select
                value={statusFilter}
                onChange={(event) => {
                  setStatusFilter(event.target.value);
                  setOffset(0);
                }}
              >
                <option value="all">全部</option>
                <option value="success">成功</option>
                <option value="partial">部分成功</option>
                <option value="failed">失败</option>
                <option value="running">运行中</option>
              </select>
            </label>
            <label className="select-field">
              <span>触发</span>
              <select
                value={triggerFilter}
                onChange={(event) => {
                  setTriggerFilter(event.target.value);
                  setOffset(0);
                }}
              >
                <option value="all">全部</option>
                <option value="schedule">定时</option>
                <option value="manual">手动</option>
                <option value="retry">重试</option>
                <option value="local">本地</option>
              </select>
            </label>
          </div>
          {!runs ? (
            <Spinner />
          ) : visibleRuns.length === 0 ? (
            <p className="muted">没有符合条件的运行记录。</p>
          ) : (
            <div className="table-wrap">
              <table className="data-table run-table responsive-table">
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>状态</th>
                    <th>触发</th>
                    <th>源</th>
                    <th>平台</th>
                    <th>接入点</th>
                    <th>国内</th>
                    <th>候选</th>
                    <th>耗时</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {visibleRuns.map((run) => {
                    const status = runTone(run);
                    return (
                      <tr key={run.id}>
                        <td data-label="时间">
                          <div className="cell-stack">
                            <div>{formatDateTime(run.finishedAt)}</div>
                            <span className="muted small">{formatRelative(run.finishedAt)}</span>
                          </div>
                        </td>
                        <td data-label="状态">
                          <span className={`pill tone-${status.tone}`}>{status.label}</span>
                        </td>
                        <td data-label="触发">{triggerLabel(run.trigger)}</td>
                        <td className="mono" data-label="源">
                          <span className="text-ok">{run.available}</span>/{run.total}
                        </td>
                        <td className="mono" data-label="平台">
                          {run.platformsOk}/{run.platformsTested}
                        </td>
                        <td className="mono" data-label="接入点">
                          {countPair(run.counts?.endpointsOk, run.counts?.endpointsTotal)}
                        </td>
                        <td className="mono" data-label="国内">
                          {countPair(run.counts?.cnOk, run.counts?.cnTested)}
                        </td>
                        <td className="mono" data-label="候选">
                          {run.counts ? `+${run.counts.candidatesAdded ?? 0}/${run.counts.candidatesPromoted ?? 0}` : '—'}
                        </td>
                        <td className="mono" data-label="耗时">{formatDuration(run.durationMs)}</td>
                        <td className="row-actions" data-label="">
                          <Link to={`/runs/${run.id}`}>详情</Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <Pagination
            total={totalRuns}
            limit={limit}
            offset={offset}
            onChange={({ limit: nextLimit, offset: nextOffset }) => {
              setLimit(nextLimit);
              setOffset(nextOffset);
            }}
            label="轮运行"
          />
        </section>
      )}

      {tab === 'platforms' && (
        <section>
          <div className="panel-head">
            <h2>平台汇总</h2>
            <span className="muted">
              近 {days} 天 · {platforms?.runCount ?? 0} 轮
            </span>
          </div>
          {!platforms ? (
            <Spinner />
          ) : platforms.rows.length === 0 ? (
            <p className="muted">这段时间没有平台测试数据。</p>
          ) : (
            <>
              <div className="stats-grid compact">
                <div className="stat-card">
                  <span className="muted">平台测试</span>
                  <strong>{platformTotals.tested.toLocaleString('zh-CN')}</strong>
                  <span className="muted small">覆盖 {platforms.rows.length} 个平台</span>
                </div>
                <div className="stat-card">
                  <span className="muted">通过</span>
                  <strong className="text-ok">{platformTotals.ok.toLocaleString('zh-CN')}</strong>
                  <span className="muted small">失败 {platformTotals.failed.toLocaleString('zh-CN')}</span>
                </div>
                <div className="stat-card">
                  <span className="muted">失败率</span>
                  <strong>{rate(platformTotals.failed, platformTotals.tested)}</strong>
                  <span className="muted small">只统计真正测过的</span>
                </div>
                <div className="stat-card">
                  <span className="muted">国内可达</span>
                  <strong>
                    <span className="text-ok">{platformTotals.cnOk}</span>/{platformTotals.cnTested}
                  </strong>
                  <span className="muted small">经国内代理补测</span>
                </div>
              </div>
              <div className="table-wrap">
                <table className="data-table platform-table">
                  <thead>
                    <tr>
                      <th>平台</th>
                      <th>轮次</th>
                      <th>已测</th>
                      <th>通过</th>
                      <th>失败</th>
                      <th>失败率</th>
                      <th>取链</th>
                      <th>首字节</th>
                      <th>总耗时</th>
                      <th>国内</th>
                      <th>主要错误</th>
                    </tr>
                  </thead>
                  <tbody>
                    {platformPager.pageItems.map((row) => {
                      const meta = platformMeta(row.platform);
                      return (
                        <tr key={row.platform}>
                          <td>
                            <span className="platform-name-cell">{meta.short}</span>
                            <span className="muted small">{meta.name}</span>
                          </td>
                          <td className="mono">{row.runs}</td>
                          <td className="mono">{row.tested}</td>
                          <td className="mono text-ok">{row.ok}</td>
                          <td className="mono text-bad">{row.failed}</td>
                          <td className="mono">{rate(row.failed, row.tested)}</td>
                          <td className="mono">{row.avgResolveMs != null ? formatMs(row.avgResolveMs) : '—'}</td>
                          <td className="mono">{row.avgTtfbMs != null ? formatMs(row.avgTtfbMs) : '—'}</td>
                          <td className="mono">{row.avgTotalMs != null ? formatMs(row.avgTotalMs) : '—'}</td>
                          <td className="mono">
                            {row.cnTested ? `${row.cnOk}/${row.cnTested}` : '—'}
                          </td>
                          <td className="small" title={row.topError?.error ?? ''}>
                            {row.topError
                              ? `${errorLabel(row.topError.kind)}（${row.topError.count}）`
                              : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  </table>
                </div>
              <Pagination {...platformPager.pagination} label="个平台" />
            </>
          )}
        </section>
      )}

      {tab === 'failures' && (
        <>
          <div className="stats-grid compact">
            <div className="stat-card">
              <span className="muted">运行轮次</span>
              <strong>{aggregate?.runCount ?? '—'}</strong>
              <span className="muted small">近 {days} 天</span>
            </div>
            <div className="stat-card">
              <span className="muted">平台测试</span>
              <strong>{aggregate ? aggregate.platformTests.toLocaleString('zh-CN') : '—'}</strong>
              <span className="muted small">
                失败 {aggregate ? aggregate.platformFailures.toLocaleString('zh-CN') : '—'}
              </span>
            </div>
            <div className="stat-card">
              <span className="muted">平台失败率</span>
              <strong>{failureRate}</strong>
              <span className="muted small">只统计真正测过的平台</span>
            </div>
            <div className="stat-card">
              <span className="muted">有失败的源</span>
              <strong>{aggregate ? aggregate.bySource.filter((item) => item.failed > 0).length : '—'}</strong>
              <span className="muted small">按失败平台数排序</span>
            </div>
          </div>

          <section>
            <div className="panel-head">
              <h2>失败原因</h2>
              <span className="muted">近 {days} 天</span>
            </div>
            {!aggregate ? (
              <Spinner />
            ) : aggregate.byKind.length === 0 ? (
              <p className="muted">这段时间没有失败记录。</p>
            ) : (
              <div className="panel failure-panel">
                {aggregate.byKind.map((item) => (
                  <div className="failure-row" key={item.kind}>
                    <div className="failure-row-head">
                      <strong>{errorLabel(item.kind)}</strong>
                      <span className="muted">{item.count} 次</span>
                    </div>
                    <div className="failure-bar">
                      <span style={{ width: `${Math.max(3, Math.round((item.count / maxKind) * 100))}%` }} />
                    </div>
                    {item.sample && <p className="failure-sample">{item.sample}</p>}
                  </div>
                ))}
              </div>
            )}
          </section>

          <section>
            <div className="panel-head">
              <h2>失败最多的源</h2>
              <Link to="/sources">查看总览</Link>
            </div>
            {!aggregate ? (
              <Spinner />
            ) : aggregate.bySource.length === 0 ? (
              <p className="muted">这段时间没有源失败。</p>
            ) : (
              <div className="failure-source-list">
                {failSourcePager.pageItems.map((item) => (
                  <div className="failure-source" key={item.sourceId}>
                    <div>
                      <Link to={`/s/${item.sourceId}`}>{item.title}</Link>
                      <span className="muted small">
                        {' '}
                        失败 {item.failed} / 已测 {item.tested}
                      </span>
                    </div>
                    {item.topError && <span className="failure-sample">{item.topError}</span>}
                  </div>
                ))}
              </div>
            )}
            {aggregate && aggregate.bySource.length > 0 && (
              <Pagination {...failSourcePager.pagination} label="个源" />
            )}
          </section>
        </>
      )}
    </div>
  );
}
