import { useEffect, useMemo, useState } from 'react';
import { formatDateTime, formatDuration, formatMs, formatRelative } from '@lx/shared';
import {
  api,
  type ProxyTestResultView,
  type ProxyTestRunDetail,
  type ProxyTestRunView,
} from '../api';
import { ErrorBox, Spinner } from '../components/Feedback';
import { Pagination, useClientPager } from '../components/Pagination';

const DAYS = [7, 14, 30];

const TRIGGER_LABEL: Record<string, string> = {
  schedule: '定时',
  manual: '手动',
  retry: '重试',
  local: '本地',
};

function triggerLabel(value: string): string {
  return TRIGGER_LABEL[value] ?? value;
}

function runTone(run: ProxyTestRunView): { label: string; tone: string } {
  if (run.total <= 0) return { label: '无节点', tone: 'idle' };
  if (run.ok >= run.total) return { label: '全部可用', tone: 'ok' };
  if (run.ok > 0) return { label: '部分可用', tone: 'warn' };
  return { label: '全部失败', tone: 'bad' };
}

function downloadCsv(run: ProxyTestRunView, rows: ProxyTestResultView[]): void {
  const header = ['节点', '协议', '主机', '端口', '结果', '延迟(ms)', '地区', 'ASN', '测试时间', '错误'];
  const lines = rows.map((row) =>
    [
      row.name || row.proxyId,
      row.protocol,
      row.host,
      row.port == null ? '' : String(row.port),
      row.ok ? '可用' : '失败',
      String(row.latencyMs),
      row.country,
      row.asn,
      row.testedAt,
      row.error ?? '',
    ].map(String),
  );
  const escape = (value: string) => (/[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  const csv = [header, ...lines].map((cells) => cells.map(escape).join(',')).join('\r\n');
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `proxy-test-${run.runId}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

export function ProxyTestsPage() {
  const [days, setDays] = useState(7);
  const [runs, setRuns] = useState<ProxyTestRunView[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProxyTestRunDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [onlyFailed, setOnlyFailed] = useState(false);
  const [query, setQuery] = useState('');

  async function loadRuns(nextDays = days) {
    setLoading(true);
    setError(null);
    try {
      const result = await api.proxyTests(nextDays);
      setRuns(result.runs);
      const stillThere = result.runs.some((run) => run.runId === selected);
      if (!stillThere) setSelected(result.runs[0]?.runId ?? null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadRuns(days);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days]);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    api
      .proxyTest(selected)
      .then((result) => {
        if (!cancelled) setDetail(result);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const filtered = useMemo(() => {
    const rows = detail?.results ?? [];
    const needle = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (onlyFailed && row.ok) return false;
      if (!needle) return true;
      return (
        row.name.toLowerCase().includes(needle) ||
        row.host.toLowerCase().includes(needle) ||
        row.error?.toLowerCase().includes(needle) ||
        row.country.toLowerCase().includes(needle)
      );
    });
  }, [detail, onlyFailed, query]);
  const resultPager = useClientPager(filtered);
  useEffect(() => {
    resultPager.reset();
  }, [detail?.run.runId, onlyFailed, query, resultPager.reset]);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="eyebrow">PROXY TEST</p>
          <h1>代理测活日志</h1>
          <p className="page-sub">
            每次测活的节点、测试时间、结果、延迟、出口地区和失败原因都记录在这里。
          </p>
        </div>
        <div className="page-actions">
          <div className="segmented">
            {DAYS.map((value) => (
              <button
                key={value}
                type="button"
                className={days === value ? 'segmented-item active' : 'segmented-item'}
                onClick={() => setDays(value)}
              >
                近 {value} 天
              </button>
            ))}
          </div>
          <button type="button" className="ghost-button" onClick={() => void loadRuns()}>
            刷新
          </button>
        </div>
      </header>

      {error ? <ErrorBox message={error} onRetry={() => void loadRuns()} /> : null}
      {loading ? <Spinner label="正在读测活日志" /> : null}

      <div className="proxy-log-layout">
        <section className="panel proxy-run-list">
          <div className="panel-head">
            <h2>测活轮次</h2>
            <span className="muted">{runs.length} 轮</span>
          </div>
          {!runs.length && !loading ? <p className="empty-box">这段时间还没有测活记录。</p> : null}
          {runs.map((run) => {
            const tone = runTone(run);
            return (
              <button
                key={run.runId}
                type="button"
                className={`proxy-run-item ${selected === run.runId ? 'is-active' : ''}`}
                onClick={() => setSelected(run.runId)}
              >
                <div className="proxy-run-top">
                  <span className={`status-badge tone-${tone.tone}`}>{tone.label}</span>
                  <span className="muted">{formatRelative(run.finishedAt)}</span>
                </div>
                <div className="proxy-run-nums">
                  <strong>
                    {run.ok}
                    <span className="muted">/{run.total}</span>
                  </strong>
                  <span className="muted">可用</span>
                  <span className="muted">·</span>
                  <span className="muted">{triggerLabel(run.trigger)}</span>
                  <span className="muted">·</span>
                  <span className="muted">{formatDuration(run.durationMs)}</span>
                </div>
                <div className="muted mono">{run.runId}</div>
              </button>
            );
          })}
        </section>

        <section className="panel proxy-log-detail">
          {!selected ? (
            <p className="empty-box">左侧选一轮测活，看每个代理的结果。</p>
          ) : detailLoading ? (
            <Spinner label="正在读节点明细" />
          ) : !detail ? (
            <p className="empty-box">没有找到这轮测活。</p>
          ) : (
            <>
              <div className="panel-head">
                <div>
                  <h2>节点明细</h2>
                  <p className="muted">
                    {formatDateTime(detail.run.finishedAt)} · {triggerLabel(detail.run.trigger)} ·
                    耗时 {formatDuration(detail.run.durationMs)}
                    {detail.run.kernelOk > 0 ? ` · 内核可用 ${detail.run.kernelOk}` : ''}
                    {detail.run.skippedUdp > 0 ? ` · 跳过 UDP ${detail.run.skippedUdp}` : ''}
                  </p>
                </div>
                <button type="button" className="ghost-button" onClick={() => downloadCsv(detail.run, filtered)}>
                  下载 CSV
                </button>
              </div>

              <div className="run-filter-bar">
                <input
                  type="search"
                  className="search-input"
                  placeholder="搜节点、主机、地区或错误"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
                <label className="check">
                  <input
                    type="checkbox"
                    checked={onlyFailed}
                    onChange={(event) => setOnlyFailed(event.target.checked)}
                  />
                  只看失败
                </label>
                <span className="muted">
                  {filtered.length}/{detail.results.length} 个节点
                </span>
              </div>

              {!filtered.length ? (
                <p className="empty-box">没有符合条件的节点。</p>
              ) : (
                <div className="table-wrap">
                  <table className="data-table proxy-log-table">
                    <thead>
                      <tr>
                        <th>节点</th>
                        <th>协议 / 地址</th>
                        <th>结果</th>
                        <th>延迟</th>
                        <th>地区</th>
                        <th>测试时间</th>
                        <th>失败原因</th>
                      </tr>
                    </thead>
                    <tbody>
                      {resultPager.pageItems.map((row) => (
                        <tr key={row.proxyId} className={row.ok ? '' : 'row-failed'}>
                          <td>
                            <div>{row.name || row.proxyId}</div>
                            <div className="muted mono">{row.proxyId.slice(0, 12)}</div>
                          </td>
                          <td>
                            <div>{row.protocol || '-'}</div>
                            <div className="muted mono">
                              {row.host}
                              {row.port ? `:${row.port}` : ''}
                              {row.kernelOnly ? ' · 内核' : ''}
                            </div>
                          </td>
                          <td>
                            <span className={`status-badge tone-${row.ok ? 'ok' : 'bad'}`}>
                              {row.ok ? '可用' : '失败'}
                            </span>
                          </td>
                          <td>{row.ok ? formatMs(row.latencyMs) : '-'}</td>
                          <td>
                            {row.country || '-'}
                            {row.asn ? <span className="muted"> {row.asn}</span> : null}
                          </td>
                          <td className="muted">{formatDateTime(row.testedAt)}</td>
                          <td className="error-cell">{row.error ?? ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <Pagination {...resultPager.pagination} label="个节点" />
            </>
          )}
        </section>
      </div>
    </div>
  );
}
