import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ERROR_LABEL,
  STATUS_META,
  formatDateTime,
  formatDuration,
  formatMs,
  platformMeta,
  type ErrorKind,
  type SourceStatus,
} from '@lx/shared';
import { ApiError, api, type RunDetailResult } from '../api';
import { ErrorBox, Spinner } from '../components/Feedback';

function errorLabel(kind: string | null): string {
  if (!kind) return '未知';
  return ERROR_LABEL[kind as ErrorKind] ?? kind;
}

function sourceTone(status: string): string {
  return STATUS_META[status as SourceStatus]?.tone ?? 'idle';
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

  const { run, sources, platforms, endpoints } = data;
  const endpointMap = new Map(endpoints.map((item) => [item.sourceId, item]));

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

      <section>
        <div className="panel-head">
          <h2>逐源结果</h2>
          <span className="muted">点开源名可看历史</span>
        </div>
        <div className="run-source-list">
          {sources.map((source) => {
            const meta = STATUS_META[source.status as SourceStatus];
            const endpoint = endpointMap.get(source.sourceId);
            const failedPlatforms = platforms.filter(
              (item) => item.sourceId === source.sourceId && item.tested && !item.ok,
            );
            const passedPlatforms = platforms.filter(
              (item) => item.sourceId === source.sourceId && item.tested && item.ok,
            );
            return (
              <details
                className={`run-source tone-${sourceTone(source.status)}`}
                key={source.sourceId}
                open={source.status !== 'available'}
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
                  <div className="chip-line">
                    {passedPlatforms.map((item) => {
                      const platform = platformMeta(item.platform);
                      return (
                        <span className="platform-chip tone-ok" key={`${item.sourceId}-${item.platform}`}>
                          <span className="platform-name">{platform.short}</span>
                          <span className="platform-value">{item.totalMs ? formatMs(item.totalMs) : '通过'}</span>
                        </span>
                      );
                    })}
                    {failedPlatforms.map((item) => {
                      const platform = platformMeta(item.platform);
                      return (
                        <span
                          className="platform-chip tone-bad"
                          key={`${item.sourceId}-${item.platform}`}
                          title={item.error ?? errorLabel(item.errorKind)}
                        >
                          <span className="platform-name">{platform.short}</span>
                          <span className="platform-value">失败</span>
                        </span>
                      );
                    })}
                  </div>
                  {failedPlatforms.length > 0 && (
                    <ul className="failure-list">
                      {failedPlatforms.map((item) => (
                        <li key={`${item.sourceId}-${item.platform}-reason`}>
                          <span className="platform-name">{platformMeta(item.platform).short}</span>
                          <span>{item.error ?? errorLabel(item.errorKind)}</span>
                          {item.cnTested && (
                            <span className={item.cnOk ? 'cn-dot cn-ok' : 'cn-dot cn-bad'} title={item.cnError ?? ''} />
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </details>
            );
          })}
        </div>
      </section>
    </div>
  );
}
