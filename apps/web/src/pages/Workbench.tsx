import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  formatDateTime,
  formatDuration,
  formatRelative,
  type StatusEnvelope,
} from '@lx/shared';
import { ApiError, api, type UsageView, type WorkflowRunsResult, type WorkflowRunView } from '../api';
import { ErrorBox, Spinner } from '../components/Feedback';

const ACTIVE = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending']);

const RUN_STATUS: Record<string, string> = {
  queued: '排队中',
  in_progress: '运行中',
  waiting: '等待中',
  requested: '已请求',
  pending: '等待中',
  completed: '已完成',
};

const CONCLUSION: Record<string, string> = {
  success: '成功',
  failure: '失败',
  cancelled: '已取消',
  skipped: '跳过',
  timed_out: '超时',
  action_required: '需处理',
};

function workflowLabel(workflow: string): string {
  return workflow === 'proxy-test' ? '代理测活' : '音源探测';
}

function runDuration(run: WorkflowRunView): string {
  const start = Date.parse(run.createdAt);
  const end = Date.parse(run.updatedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '—';
  return formatDuration(end - start);
}

function nextProxyTestAt(now = new Date()): Date {
  for (let day = 0; day < 8; day += 1) {
    for (const hour of [0, 6, 12, 18]) {
      const candidate = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + day, hour, 23, 0, 0),
      );
      if (candidate.getTime() > now.getTime()) return candidate;
    }
  }
  return new Date(now.getTime() + 6 * 3600_000);
}

function pct(value: number, max: number): number {
  if (!Number.isFinite(value) || max <= 0) return 0;
  return Math.max(2, Math.min(100, Math.round((value / max) * 100)));
}

function usageCards(usage: UsageView) {
  return [
    {
      key: 'kv-writes',
      label: 'KV 写入',
      value: usage.kv.writes,
      max: 1000,
      hint: `删除 ${usage.kv.deletes} · 列表 ${usage.kv.lists}`,
    },
    {
      key: 'kv-reads',
      label: 'KV 读取',
      value: usage.kv.reads,
      max: 100_000,
      hint: `存储 ${(usage.kv.storageBytes / 1024).toFixed(1)} KB`,
    },
    {
      key: 'd1-writes',
      label: 'D1 写入行',
      value: usage.d1.rowsWritten,
      max: 100_000,
      hint: `读取 ${usage.d1.rowsRead.toLocaleString('zh-CN')} 行`,
    },
    {
      key: 'actions',
      label: 'Actions 本月',
      value: usage.github.runs,
      max: 0,
      hint: usage.github.private ? `${usage.github.minutes} 分钟（私有仓计费）` : '公开仓库，不计分钟',
    },
  ];
}

export function WorkbenchPage() {
  const [status, setStatus] = useState<StatusEnvelope | null>(null);
  const [usage, setUsage] = useState<UsageView | null>(null);
  const [workflows, setWorkflows] = useState<WorkflowRunsResult | null>(null);
  const [error, setError] = useState('');
  const [action, setAction] = useState('');
  const [busy, setBusy] = useState<'probe' | 'proxy' | 'usage' | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      const [statusResult, usageResult, workflowResult] = await Promise.all([
        api.status(),
        api.usage(),
        api.workflows(),
      ]);
      setStatus(statusResult);
      setUsage(usageResult.usage);
      setWorkflows(workflowResult);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '加载工作台失败');
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(kind: 'probe' | 'proxy') {
    setBusy(kind);
    setAction('');
    try {
      const result =
        kind === 'probe'
          ? await api.runProbe({ limit: '3', preferMirror: true })
          : await api.runProxyTest({});
      setAction(`已触发${kind === 'probe' ? '音源探测' : '代理测活'}（${formatDateTime(result.dispatchedAt)}），约 1–2 分钟后刷新可看到状态。`);
      window.setTimeout(() => void load(), 4000);
    } catch (err) {
      setAction(err instanceof ApiError ? err.message : '触发失败');
    } finally {
      setBusy(null);
    }
  }

  async function refreshUsage() {
    setBusy('usage');
    setAction('');
    try {
      const result = await api.usage(true);
      setUsage(result.usage);
      setAction('额度数据已刷新。');
    } catch (err) {
      setAction(err instanceof ApiError ? err.message : '刷新额度失败');
    } finally {
      setBusy(null);
    }
  }

  const summary = status?.snapshot.summary;
  const running = (workflows?.runs ?? []).filter((run) => ACTIVE.has(run.status));
  const finished = (workflows?.runs ?? []).filter((run) => !ACTIVE.has(run.status)).slice(0, 8);
  const nextProbe = status?.snapshot.nextCheckAt;
  const proxyNext = nextProxyTestAt();

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <span className="eyebrow">WORKBENCH</span>
          <h1>工作台</h1>
          <p className="muted">任务状态、最近运行和额度用量都在这页；探测和测活都由 GitHub Actions 执行。</p>
        </div>
        <button type="button" className="ghost-button" onClick={() => void load()} disabled={!loaded}>
          刷新
        </button>
      </div>

      {error && <ErrorBox message={error} />}
      {!loaded && !error && <Spinner label="正在加载工作台…" />}

      {loaded && usage && (
        <div className="usage-grid">
          {usageCards(usage).map((card) => (
            <div className="usage-card" key={card.key}>
              <span className="usage-label">{card.label}</span>
              <div className="usage-value">
                {card.value.toLocaleString('zh-CN')}
                {card.max > 0 && <span className="usage-max"> / {card.max.toLocaleString('zh-CN')}</span>}
              </div>
              {card.max > 0 && (
                <div className="usage-meter">
                  <span style={{ width: `${pct(card.value, card.max)}%` }} />
                </div>
              )}
              <span className="usage-hint">{card.hint}</span>
            </div>
          ))}
        </div>
      )}

      {usage?.cloudflareError && (
        <div className="notice">
          Cloudflare 统计暂不可用：{usage.cloudflareError}。KV/D1 数字可能是上次采集值。
          <button type="button" className="link-button" onClick={() => void refreshUsage()} disabled={busy === 'usage'}>
            重试
          </button>
        </div>
      )}

      <section>
        <h2>任务中心</h2>
        <div className="task-grid">
          <div className="panel task-panel">
            <div className="panel-head">
              <h3>正在运行</h3>
              <span className="muted">{running.length > 0 ? `${running.length} 个` : '空闲'}</span>
            </div>
            {running.length === 0 ? (
              <p className="muted">当前没有排队或运行中的任务。</p>
            ) : (
              <ul className="task-list">
                {running.map((run) => (
                  <li key={run.id}>
                    <span className="pill run-in_progress">{RUN_STATUS[run.status] ?? run.status}</span>
                    <div className="task-main">
                      <strong>{workflowLabel(run.workflow)}</strong>
                      <span className="muted">
                        {run.event === 'workflow_dispatch' ? '手动触发' : run.event === 'schedule' ? '定时触发' : run.event} ·{' '}
                        {formatRelative(run.createdAt)}
                      </span>
                    </div>
                    {run.url && (
                      <a href={run.url} target="_blank" rel="noreferrer">
                        日志
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="panel task-panel">
            <div className="panel-head">
              <h3>定时计划</h3>
              <span className="muted">Actions 定时</span>
            </div>
            <div className="schedule-list">
              <div className="schedule-item">
                <div>
                  <strong>音源探测</strong>
                  <span className="muted">
                    {nextProbe ? `下次 ${formatDateTime(nextProbe)}` : '每 4 小时一轮'}
                    {summary ? ` · 上轮 ${summary.available} 可用 / ${summary.total} 源` : ''}
                  </span>
                </div>
                <button type="button" className="primary-button" onClick={() => void run('probe')} disabled={busy !== null}>
                  {busy === 'probe' ? '触发中…' : '立即运行'}
                </button>
              </div>
              <div className="schedule-item">
                <div>
                  <strong>代理测活</strong>
                  <span className="muted">每 6 小时 · 下次 {formatDateTime(proxyNext.toISOString())}</span>
                </div>
                <button type="button" className="ghost-button" onClick={() => void run('proxy')} disabled={busy !== null}>
                  {busy === 'proxy' ? '触发中…' : '立即测活'}
                </button>
              </div>
            </div>
          </div>
        </div>
        {action && <div className="form-message">{action}</div>}
      </section>

      <section>
        <div className="panel-head">
          <h2>最近运行</h2>
          <div className="panel-links">
            <Link to="/runs">快照运行记录</Link>
            <a href="https://github.com/fade09675/lx-source-watch/actions" target="_blank" rel="noreferrer">
              全部运行
            </a>
          </div>
        </div>
        {!workflows ? (
          <Spinner />
        ) : finished.length === 0 ? (
          <p className="muted">暂时没有已完成的运行记录。</p>
        ) : (
          <div className="table-wrap">
            <table className="data-table run-table">
              <thead>
                <tr>
                  <th>工作流</th>
                  <th>状态</th>
                  <th>触发</th>
                  <th>开始</th>
                  <th>耗时</th>
                  <th>结果</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {finished.map((run) => (
                  <tr key={run.id}>
                    <td>{workflowLabel(run.workflow)}</td>
                    <td>
                      <span className={`pill run-${run.status}`}>{RUN_STATUS[run.status] ?? run.status}</span>
                    </td>
                    <td className="muted">
                      {run.event === 'workflow_dispatch' ? '手动' : run.event === 'schedule' ? '定时' : run.event}
                    </td>
                    <td className="muted">{formatDateTime(run.createdAt)}</td>
                    <td className="mono">{runDuration(run)}</td>
                    <td>
                      <span className={run.conclusion === 'success' ? 'text-ok' : 'text-bad'}>
                        {run.conclusion ? (CONCLUSION[run.conclusion] ?? run.conclusion) : '—'}
                      </span>
                    </td>
                    <td>
                      {run.url && (
                        <a href={run.url} target="_blank" rel="noreferrer">
                          日志
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {workflows?.errors?.map((item) => (
          <p className="muted" key={item}>
            {item}
          </p>
        ))}
      </section>
    </div>
  );
}
