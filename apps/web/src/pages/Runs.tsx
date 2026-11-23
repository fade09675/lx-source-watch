import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ERROR_LABEL,
  formatDateTime,
  formatDuration,
  formatRelative,
  platformMeta,
  type ErrorKind,
  type RunSummary,
} from '@lx/shared';
import { ApiError, api, type FailureAggregate } from '../api';
import { ErrorBox, Spinner } from '../components/Feedback';

function runTone(run: RunSummary): { label: string; tone: string } {
  if (run.total === 0) return { label: '空', tone: 'idle' };
  if (run.available === run.total) return { label: '全可用', tone: 'ok' };
  if (run.available === 0 && run.partial === 0 && run.untested === 0) return { label: '不可用', tone: 'bad' };
  if (run.available > 0) return { label: '部分可用', tone: 'warn' };
  return { label: '基本失效', tone: 'bad' };
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
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [aggregate, setAggregate] = useState<FailureAggregate | null>(null);
  const [error, setError] = useState('');
  const [days, setDays] = useState(7);

  useEffect(() => {
    let cancelled = false;
    setError('');
    setAggregate(null);
    Promise.all([api.snapshots(30), api.failures(days)])
      .then(([runResult, failureResult]) => {
        if (cancelled) return;
        setRuns(runResult.runs);
        setAggregate(failureResult);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : '加载运行记录失败');
      });
    return () => {
      cancelled = true;
    };
  }, [days]);

  const maxKind = Math.max(1, ...(aggregate?.byKind.map((item) => item.count) ?? [1]));
  const failureRate =
    aggregate && aggregate.platformTests > 0
      ? `${Math.round((aggregate.platformFailures / aggregate.platformTests) * 100)}%`
      : '—';

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <span className="eyebrow">OPERATIONS</span>
          <h1>运行与日志</h1>
          <p className="muted">每轮探测的结果、失败原因聚合都在这里；任务运行状态请看工作台。</p>
        </div>
        <div className="segmented">
          {[7, 14, 30].map((value) => (
            <button
              key={value}
              type="button"
              className={value === days ? 'segmented-item active' : 'segmented-item'}
              onClick={() => setDays(value)}
            >
              近 {value} 天
            </button>
          ))}
        </div>
      </div>

      {error && <ErrorBox message={error} />}
      {!runs && !error && <Spinner label="正在加载运行记录…" />}

      {aggregate && (
        <div className="stats-grid compact">
          <div className="stat-card">
            <span className="muted">运行轮次</span>
            <strong>{aggregate.runCount}</strong>
            <span className="muted small">近 {aggregate.days} 天</span>
          </div>
          <div className="stat-card">
            <span className="muted">平台测试</span>
            <strong>{aggregate.platformTests.toLocaleString('zh-CN')}</strong>
            <span className="muted small">失败 {aggregate.platformFailures.toLocaleString('zh-CN')}</span>
          </div>
          <div className="stat-card">
            <span className="muted">平台失败率</span>
            <strong>{failureRate}</strong>
            <span className="muted small">只统计真正测过的平台</span>
          </div>
          <div className="stat-card">
            <span className="muted">有失败的源</span>
            <strong>{aggregate.bySource.filter((item) => item.failed > 0).length}</strong>
            <span className="muted small">按失败平台数排序</span>
          </div>
        </div>
      )}

      <section>
        <h2>失败原因</h2>
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
          <h2>平台失败率</h2>
          <span className="muted">近 {days} 天</span>
        </div>
        {!aggregate ? (
          <Spinner />
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>平台</th>
                  <th>已测</th>
                  <th>失败</th>
                  <th>失败率</th>
                  <th className="bar-col">分布</th>
                </tr>
              </thead>
              <tbody>
                {aggregate.byPlatform.map((item) => {
                  const meta = platformMeta(item.platform);
                  const failedRate = item.tested > 0 ? item.failed / item.tested : 0;
                  return (
                    <tr key={item.platform}>
                      <td>
                        <span className="platform-name-cell">{meta.short}</span>
                        <span className="muted small">{meta.name}</span>
                      </td>
                      <td className="mono">{item.tested}</td>
                      <td className="mono">{item.failed}</td>
                      <td className="mono">{rate(item.failed, item.tested)}</td>
                      <td>
                        <div className="mini-bar">
                          <span style={{ width: `${Math.max(2, Math.round(failedRate * 100))}%` }} />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
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
        ) : (
          <div className="failure-source-list">
            {aggregate.bySource.map((item) => (
              <div className="failure-source" key={item.sourceId}>
                <div>
                  <Link to={`/s/${item.sourceId}`}>{item.title}</Link>
                  <span className="muted small"> 失败 {item.failed} / 已测 {item.tested}</span>
                </div>
                {item.topError && <span className="failure-sample">{item.topError}</span>}
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <div className="panel-head">
          <h2>运行记录</h2>
          <span className="muted">每轮上报生成一条</span>
        </div>
        {!runs ? (
          <Spinner />
        ) : runs.length === 0 ? (
          <p className="muted">还没有运行记录。</p>
        ) : (
          <div className="table-wrap">
            <table className="data-table run-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>状态</th>
                  <th>源</th>
                  <th>可用 / 部分 / 失效 / 未测</th>
                  <th>平台</th>
                  <th>耗时</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => {
                  const status = runTone(run);
                  return (
                    <tr key={run.id}>
                      <td>
                        <div>{formatDateTime(run.finishedAt)}</div>
                        <span className="muted small">{formatRelative(run.finishedAt)}</span>
                      </td>
                      <td>
                        <span className={`pill tone-${status.tone}`}>{status.label}</span>
                      </td>
                      <td className="mono">{run.total}</td>
                      <td className="mono">
                        <span className="text-ok">{run.available}</span> / {run.partial} /{' '}
                        <span className="text-bad">{run.unavailable}</span> / {run.untested}
                      </td>
                      <td className="mono">
                        {run.platformsOk}/{run.platformsTested}
                      </td>
                      <td className="mono">{formatDuration(run.durationMs)}</td>
                      <td>
                        <Link to={`/runs/${run.id}`}>详情</Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
