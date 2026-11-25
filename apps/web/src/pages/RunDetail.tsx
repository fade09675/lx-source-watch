import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ERROR_LABEL,
  STATUS_META,
  formatDateTime,
  formatDuration,
  formatMs,
  platformMeta,
  safeUrlHost,
  type ErrorKind,
  type SourceStatus,
} from '@lx/shared';
import { ApiError, api, type RunDetailResult, type RunEndpointRow } from '../api';
import { ErrorBox, Spinner } from '../components/Feedback';
import { Pagination, useClientPager } from '../components/Pagination';
import { RunLog } from '../components/RunLog';

function errorLabel(kind: string | null): string {
  if (!kind) return '未知';
  return ERROR_LABEL[kind as ErrorKind] ?? kind;
}

function sourceTone(status: string): string {
  return STATUS_META[status as SourceStatus]?.tone ?? 'idle';
}

const VERSION_STATE_LABEL: Record<string, { label: string; tone: string }> = {
  synced: { label: '已同步', tone: 'ok' },
  lagging: { label: '版本落后', tone: 'warn' },
  unknown: { label: '未知', tone: 'idle' },
};

function versionState(state: string | null): { label: string; tone: string } {
  return (state && VERSION_STATE_LABEL[state]) || { label: '未知', tone: 'idle' };
}

function endLabel(endpoint: RunEndpointRow): string {
  return endpoint.role === 'primary' ? '主地址' : '镜像';
}

interface FailureGroup {
  key: string;
  kind: string | null;
  error: string;
  count: number;
  platforms: string[];
}

export function RunDetailPage() {
  const { runId = '' } = useParams();
  const [data, setData] = useState<RunDetailResult | null>(null);
  const [error, setError] = useState('');
  const [logQuery, setLogQuery] = useState('');
  const sourcePager = useClientPager(data?.sources ?? [], 10);
  const resetSourcePage = sourcePager.reset;

  useEffect(() => {
    resetSourcePage();
  }, [runId, resetSourcePage]);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError('');
    api
      .snapshot(runId)
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : '加载运行详情失败');
      });
    return () => {
      cancelled = true;
    };
  }, [runId]);

  if (error) {
    return (
      <div className="page">
        <ErrorBox message={error} />
        <Link to="/runs">← 返回运行与日志</Link>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="page">
        <Spinner label="正在加载运行详情…" />
      </div>
    );
  }

  const { run, sources, platforms, endpoints, endpointRows } = data;
  const endpointMap = new Map(endpoints.map((item) => [item.sourceId, item]));
  const endpointGroups = new Map<string, RunEndpointRow[]>();
  for (const row of endpointRows) {
    const list = endpointGroups.get(row.sourceId) ?? [];
    list.push(row);
    endpointGroups.set(row.sourceId, list);
  }
  const counts = run.counts;

  const failures: FailureGroup[] = [];
  const failureIndex = new Map<string, FailureGroup>();
  for (const platform of platforms) {
    if (!platform.tested || platform.ok) continue;
    const key = `${platform.errorKind ?? 'unknown'}|${platform.error ?? ''}`;
    let group = failureIndex.get(key);
    if (!group) {
      group = {
        key,
        kind: platform.errorKind,
        error: platform.error ?? '未返回错误信息',
        count: 0,
        platforms: [],
      };
      failureIndex.set(key, group);
      failures.push(group);
    }
    group.count += 1;
    group.platforms.push(platformMeta(platform.platform).short);
  }
  failures.sort((a, b) => b.count - a.count);
  const maxFailure = Math.max(1, ...failures.map((item) => item.count));

  const searchLog = (value: string) => {
    setLogQuery(value.slice(0, 60));
    window.requestAnimationFrame(() => {
      document.getElementById('run-log')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };

  return (
    <div className="page">
      <Link to="/runs" className="back-link">
        ← 返回运行与日志
      </Link>

      <div className="page-head">
        <div>
          <span className="eyebrow">RUN DETAIL</span>
          <h1>运行 {run.id}</h1>
          <p className="muted">
            {formatDateTime(run.finishedAt)} · 耗时 {formatDuration(run.durationMs)} · 平台通过{' '}
            {run.platformsOk}/{run.platformsTested}
          </p>
        </div>
        <span className={`pill tone-${run.available > 0 ? 'ok' : 'bad'}`}>
          {run.available} / {run.total} 源可用
        </span>
      </div>

      <div className="stats-grid compact">
        <div className="stat-card">
          <span className="muted">音源</span>
          <strong>{run.total}</strong>
          <span className="muted small">本轮参与检测</span>
        </div>
        <div className="stat-card">
          <span className="muted">可用</span>
          <strong className="text-ok">{run.available}</strong>
          <span className="muted small">全部声明平台通过</span>
        </div>
        <div className="stat-card">
          <span className="muted">部分可用</span>
          <strong>{run.partial}</strong>
          <span className="muted small">至少一个平台通过</span>
        </div>
        <div className="stat-card">
          <span className="muted">失效 / 未测</span>
          <strong>
            <span className="text-bad">{run.unavailable}</span> / {run.untested}
          </strong>
          <span className="muted small">通过 0 个 / 没有测试曲</span>
        </div>
      </div>

      {counts && (
        <div className="stats-grid compact">
          <div className="stat-card">
            <span className="muted">接入点</span>
            <strong>
              <span className="text-ok">{counts.endpointsOk}</span>/{counts.endpointsTotal}
            </strong>
            <span className="muted small">主地址 + 镜像下载成功</span>
          </div>
          <div className="stat-card">
            <span className="muted">国内补测</span>
            <strong>
              <span className={counts.cnOk > 0 ? 'text-ok' : 'text-bad'}>{counts.cnOk}</span>/{counts.cnTested}
            </strong>
            <span className="muted small">经国内代理可达</span>
          </div>
          <div className="stat-card">
            <span className="muted">候选</span>
            <strong>
              +{counts.candidatesAdded}/{counts.candidatesPromoted}
            </strong>
            <span className="muted small">新增 / 自动收录</span>
          </div>
          <div className="stat-card">
            <span className="muted">代理</span>
            <strong>{counts.proxiesUsed}</strong>
            <span className="muted small">本轮使用节点</span>
          </div>
        </div>
      )}

      {run.steps && run.steps.length > 0 && (
        <section>
          <div className="panel-head">
            <h2>执行步骤</h2>
            <span className="muted">{run.steps.length} 步</span>
          </div>
          <div className="run-steps">
            {run.steps.map((step) => (
              <div className={`run-step tone-${step.status}`} key={step.key}>
                <span className="run-step-dot" />
                <div>
                  <strong>{step.label}</strong>
                  <span className="muted small">
                    {step.durationMs != null ? ` · ${formatMs(step.durationMs)}` : ''}
                    {step.message ? ` · ${step.message}` : ''}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <div className="panel-head">
          <h2>失败原因</h2>
          <span className="muted">{failures.length} 类</span>
        </div>
        {failures.length === 0 ? (
          <p className="muted">本轮没有平台失败。</p>
        ) : (
          <div className="panel failure-panel">
            {failures.map((item) => (
              <div className="failure-row" key={item.key}>
                <div className="failure-row-head">
                  <strong>{errorLabel(item.kind)}</strong>
                  <span className="muted">
                    {item.count} 个平台 · {item.platforms.join('、')}
                  </span>
                  <button type="button" className="link-button" onClick={() => searchLog(item.error)}>
                    在日志中查
                  </button>
                </div>
                <div className="failure-bar">
                  <span style={{ width: `${Math.max(3, Math.round((item.count / maxFailure) * 100))}%` }} />
                </div>
                <p className="failure-sample">{item.error}</p>
              </div>
            ))}
          </div>
        )}
      </section>

      <RunLog runId={run.id} query={logQuery} onQueryChange={setLogQuery} />

      <section>
        <div className="panel-head">
          <h2>逐源结果</h2>
          <span className="muted">点开源名可看历史</span>
        </div>
        <div className="run-source-list">
          {sourcePager.pageItems.map((source) => {
            const meta = STATUS_META[source.status as SourceStatus];
            const endpoint = endpointMap.get(source.sourceId);
            const sourceEndpoints = endpointGroups.get(source.sourceId) ?? [];
            const sourcePlatforms = platforms.filter((item) => item.sourceId === source.sourceId);
            return (
              <details
                className={`run-source tone-${sourceTone(source.status)}`}
                key={source.sourceId}
              >
                <summary>
                  <Link to={`/s/${source.sourceId}`} onClick={(event) => event.stopPropagation()}>
                    {source.title}
                  </Link>
                  <span className={`pill tone-${meta.tone}`}>{meta.label}</span>
                  <span className="muted small">
                    {source.ok}/{source.tested} 平台
                    {endpoint ? ` · 接入点 ${endpoint.ok}/${endpoint.total}` : ''}
                    {' · '}
                    {formatDuration(source.durationMs)}
                  </span>
                </summary>
                <div className="run-source-body">
                  {source.initError && <p className="failure-sample">初始化失败：{source.initError}</p>}
                  <div className="source-facts">
                    <span>版本：{source.version ?? '未知'}</span>
                    <span>sha：{source.scriptSha ? source.scriptSha.slice(0, 12) : '—'}</span>
                    <span>
                      接入点：<span className="text-ok">{source.endpointsOk}</span>/{source.endpointsTotal}
                    </span>
                    <span>
                      平台：<span className="text-ok">{source.ok}</span>/{source.tested}
                    </span>
                    <span>声明：{source.total} 个平台</span>
                  </div>

                  <h3 className="subhead">接入点</h3>
                  {sourceEndpoints.length === 0 ? (
                    <p className="muted small">本轮没有接入点明细（旧格式运行）。</p>
                  ) : (
                    <div className="table-wrap">
                      <table className="data-table compact-table">
                        <thead>
                          <tr>
                            <th>地址</th>
                            <th>角色</th>
                            <th>下载</th>
                            <th>国内</th>
                            <th>版本</th>
                            <th>耗时</th>
                            <th>错误</th>
                          </tr>
                        </thead>
                        <tbody>
                          {sourceEndpoints.map((endpoint) => {
                            const state = versionState(endpoint.versionState);
                            return (
                              <tr key={endpoint.url}>
                                <td className="mono small" title={endpoint.url}>
                                  {safeUrlHost(endpoint.url)}
                                </td>
                                <td>{endLabel(endpoint)}</td>
                                <td>
                                  <span className={`pill tone-${endpoint.ok ? 'ok' : 'bad'}`}>
                                    {endpoint.ok ? '成功' : '失败'}
                                  </span>
                                </td>
                                <td>
                                  {endpoint.cn ? (
                                    <span
                                      className={`pill tone-${endpoint.cn.ok ? 'ok' : 'bad'}`}
                                      title={endpoint.cn.error ?? ''}
                                    >
                                      {endpoint.cn.ok ? `可达 ${formatMs(endpoint.cn.ms)}` : '失败'}
                                    </span>
                                  ) : (
                                    <span className="muted small">—</span>
                                  )}
                                </td>
                                <td>
                                  {endpoint.version ?? '—'}{' '}
                                  <span className={`pill tone-${state.tone}`}>{state.label}</span>
                                </td>
                                <td className="mono">{formatMs(endpoint.ms)}</td>
                                <td className="small" title={endpoint.error ?? ''}>
                                  {endpoint.error ?? '—'}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}

                  <h3 className="subhead">平台</h3>
                  <div className="table-wrap">
                    <table className="data-table compact-table">
                      <thead>
                        <tr>
                          <th>平台</th>
                          <th>音质</th>
                          <th>结果</th>
                          <th>取链</th>
                          <th>首字节</th>
                          <th>总耗时</th>
                          <th>国内</th>
                          <th>错误</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sourcePlatforms.map((item) => {
                          const platform = platformMeta(item.platform);
                          return (
                            <tr key={`${item.sourceId}-${item.platform}`}>
                              <td>
                                <span className="platform-name-cell">{platform.short}</span>
                                <span className="muted small">{platform.name}</span>
                              </td>
                              <td className="mono small">{item.quality ?? '—'}</td>
                              <td>
                                <span
                                  className={`pill tone-${item.tested ? (item.ok ? 'ok' : 'bad') : 'idle'}`}
                                  title={item.error ?? ''}
                                >
                                  {item.tested ? (item.ok ? '通过' : '失败') : '未测'}
                                </span>
                              </td>
                              <td className="mono">{item.resolveMs != null ? formatMs(item.resolveMs) : '—'}</td>
                              <td className="mono">{item.ttfbMs != null ? formatMs(item.ttfbMs) : '—'}</td>
                              <td className="mono">{item.totalMs != null ? formatMs(item.totalMs) : '—'}</td>
                              <td>
                                {item.cnTested ? (
                                  <span className={item.cnOk ? 'cn-dot cn-ok' : 'cn-dot cn-bad'} title={item.cnError ?? ''} />
                                ) : (
                                  <span className="muted small">未测</span>
                                )}
                              </td>
                              <td className="small" title={item.error ?? ''}>
                                {item.error ?? (item.httpStatus ? `HTTP ${item.httpStatus}` : '—')}
                                {item.error && (
                                  <button
                                    type="button"
                                    className="link-button small"
                                    onClick={() => searchLog(item.error ?? '')}
                                  >
                                    查日志
                                  </button>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              </details>
            );
          })}
        </div>
        <Pagination {...sourcePager.pagination} label="个音源" />
      </section>
    </div>
  );
}
