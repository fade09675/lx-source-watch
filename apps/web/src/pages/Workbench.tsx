import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  formatDateTime,
  formatDuration,
  formatRelative,
  type StatusEnvelope,
  type RunSummary,
} from '@lx/shared';
import {
  ApiError,
  api,
  type CreateTaskResult,
  type SystemView,
  type TaskListResult,
  type TaskType,
  type TaskView,
  type UsageView,
} from '../api';
import { ErrorBox, Spinner } from '../components/Feedback';

const TASK_TYPE_LABEL: Record<TaskType, string> = {
  probe: '音源探测',
  discovery: '自动发现',
  'source-test': '单源测试',
  'proxy-test': '代理测活',
};

const TASK_STATUS_LABEL: Record<string, string> = {
  queued: '排队中',
  running: '运行中',
  succeeded: '成功',
  failed: '失败',
  cancelled: '已取消',
};

const RUN_STATUS_LABEL: Record<string, string> = {
  success: '成功',
  partial: '部分成功',
  failed: '失败',
  running: '运行中',
};

function pct(value: number, max: number): number {
  if (!Number.isFinite(value) || max <= 0) return 0;
  return Math.max(2, Math.min(100, Math.round((value / max) * 100)));
}

function taskType(task: TaskView): string {
  return TASK_TYPE_LABEL[task.type] ?? task.type;
}

function taskElapsed(task: TaskView): string {
  const start = Date.parse(task.startedAt ?? task.createdAt);
  const end = task.finishedAt ? Date.parse(task.finishedAt) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '—';
  return formatDuration(end - start);
}

function runStatus(run: RunSummary): string {
  if (run.status) return run.status;
  if (run.available > 0 && run.partial === 0 && run.unavailable === 0 && run.untested === 0) return 'success';
  if (run.available > 0 || run.partial > 0) return 'partial';
  return 'failed';
}

function runTone(status: string): string {
  if (status === 'success') return 'ok';
  if (status === 'partial' || status === 'running') return 'warn';
  return 'bad';
}

function triggerLabel(trigger?: string): string {
  if (trigger === 'schedule') return '定时';
  if (trigger === 'manual') return '手动';
  if (trigger === 'retry') return '重试';
  if (trigger === 'local') return '本地';
  return trigger ?? '—';
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
  const [system, setSystem] = useState<SystemView | null>(null);
  const [tasks, setTasks] = useState<TaskListResult | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [error, setError] = useState('');
  const [action, setAction] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      const [statusResult, usageResult, systemResult, taskResult, runResult] = await Promise.all([
        api.status(),
        api.usage(),
        api.system(),
        api.tasks(undefined, 40),
        api.snapshots(12),
      ]);
      setStatus(statusResult);
      setUsage(usageResult.usage);
      setSystem(systemResult);
      setTasks(taskResult);
      setRuns(runResult.runs);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '加载工作台失败');
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function runTask(type: TaskType) {
    setBusy(type);
    setAction('');
    try {
      const payload =
        type === 'probe'
          ? { preferMirror: true }
          : type === 'discovery'
            ? { preferMirror: true, concurrency: 1 }
            : {};
      const result: CreateTaskResult = await api.createTask({ type, payload });
      const message = result.dispatch.dispatched
        ? `已派发${TASK_TYPE_LABEL[type]}任务，约 1–2 分钟后刷新可看到结果。`
        : `任务已入队：${result.dispatch.message ?? '等待派发'}`;
      setAction(message);
      window.setTimeout(() => void load(), 3000);
    } catch (err) {
      setAction(err instanceof ApiError ? err.message : '创建任务失败');
    } finally {
      setBusy(null);
    }
  }

  async function cancel(task: TaskView) {
    setBusy(task.id);
    try {
      await api.cancelTask(task.id);
      setAction(`已取消${taskType(task)}任务。`);
      await load();
    } catch (err) {
      setAction(err instanceof ApiError ? err.message : '取消失败');
    } finally {
      setBusy(null);
    }
  }

  async function dispatchQueued() {
    setBusy('dispatch');
    try {
      const result = await api.dispatchTasks();
      setAction(result.dispatched ? '已派发一个排队任务。' : result.message ?? '当前没有可派发的任务。');
      await load();
    } catch (err) {
      setAction(err instanceof ApiError ? err.message : '派发失败');
    } finally {
      setBusy(null);
    }
  }

  async function reap() {
    setBusy('reap');
    try {
      const result = await api.reapTasks();
      setAction(result.reaped > 0 ? `已清理 ${result.reaped} 个卡死任务。` : '没有卡死任务。');
      await load();
    } catch (err) {
      setAction(err instanceof ApiError ? err.message : '清理失败');
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
  const counts = tasks?.counts ?? { queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 };
  const running = tasks?.state.running ?? [];
  const queued = tasks?.state.queued ?? [];
  const scheduler = system?.scheduler;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <span className="eyebrow">WORKBENCH</span>
          <h1>工作台</h1>
          <p className="muted">
            所有会派发 Actions 的操作都先建任务；Worker 每 5 分钟检查一次，到点后按队列依次派发。
          </p>
        </div>
        <div className="page-actions">
          <button type="button" className="ghost-button" onClick={() => void dispatchQueued()} disabled={busy !== null}>
            {busy === 'dispatch' ? '派发中…' : '派发排队任务'}
          </button>
          <button type="button" className="ghost-button" onClick={() => void load()} disabled={!loaded}>
            刷新
          </button>
        </div>
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
        <div className="panel-head">
          <h2>任务中心</h2>
          <span className="muted small">
            运行 {counts.running} · 排队 {counts.queued} · 成功 {counts.succeeded} · 失败 {counts.failed}
          </span>
        </div>

        <div className="task-actions">
          <button type="button" className="primary-button" onClick={() => void runTask('probe')} disabled={busy !== null}>
            {busy === 'probe' ? '创建中…' : '立即探测'}
          </button>
          <button type="button" className="ghost-button" onClick={() => void runTask('proxy-test')} disabled={busy !== null}>
            {busy === 'proxy-test' ? '创建中…' : '立即测活'}
          </button>
          <button type="button" className="ghost-button" onClick={() => void runTask('discovery')} disabled={busy !== null}>
            {busy === 'discovery' ? '创建中…' : '立即发现'}
          </button>
          <button type="button" className="ghost-button" onClick={() => void reap()} disabled={busy !== null}>
            清理卡死
          </button>
        </div>

        {summary && (
          <p className="muted small">
            最新快照：{summary.available} 可用 / {summary.partial} 部分 / {summary.unavailable} 失效 / {summary.untested} 未测，
            共 {summary.total} 源；平台通过 {summary.platformsOk}/{summary.platformsTested}。
          </p>
        )}

        <div className="task-grid">
          <div className="panel task-panel">
            <div className="panel-head">
              <h3>正在运行</h3>
              <span className="muted">{running.length > 0 ? `${running.length} 个` : '空闲'}</span>
            </div>
            {running.length === 0 ? (
              <p className="muted">当前没有运行中的任务。</p>
            ) : (
              <ul className="task-list">
                {running.map((task) => {
                  const percent = task.progress.total > 0 ? Math.round((task.progress.done / task.progress.total) * 100) : 0;
                  return (
                    <li key={task.id}>
                      <span className="pill run-in_progress">{TASK_STATUS_LABEL[task.status] ?? task.status}</span>
                      <div className="task-main">
                        <strong>{taskType(task)}</strong>
                        <span className="muted">
                          {task.message || '已派发，等待 Actions 开始'} · {taskElapsed(task)}
                        </span>
                        {task.progress.total > 0 && (
                          <div className="meter">
                            <span style={{ width: `${percent}%` }} />
                          </div>
                        )}
                      </div>
                      <div className="task-side">
                        {task.runId && <Link to={`/runs/${task.runId}`}>运行记录</Link>}
                        <button type="button" className="link-button danger" onClick={() => void cancel(task)} disabled={busy !== null}>
                          取消
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="panel task-panel">
            <div className="panel-head">
              <h3>排队中</h3>
              <span className="muted">{queued.length > 0 ? `${queued.length} 个` : '空'}</span>
            </div>
            {queued.length === 0 ? (
              <p className="muted">队列为空。</p>
            ) : (
              <ul className="task-list">
                {queued.map((task) => (
                  <li key={task.id}>
                    <span className="pill run-queued">P{task.priority}</span>
                    <div className="task-main">
                      <strong>{taskType(task)}</strong>
                      <span className="muted">
                        {task.source === 'schedule' ? '定时入队' : '手动入队'} · {formatRelative(task.createdAt)}
                        {task.payload.limit ? ` · 最多 ${task.payload.limit} 源` : ''}
                      </span>
                    </div>
                    <div className="task-side">
                      <button type="button" className="link-button danger" onClick={() => void cancel(task)} disabled={busy !== null}>
                        取消
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="panel task-panel">
          <div className="panel-head">
            <h3>定时计划</h3>
            <span className="muted small">Worker 定时</span>
          </div>
          <div className="schedule-list">
            <div className="schedule-item">
              <div>
                <strong>音源探测</strong>
                <span className="muted">
                  {scheduler?.probe.enabled === false ? '已关闭' : `每 ${scheduler?.probe.intervalHours ?? 4} 小时`}
                  {scheduler?.probe.nextAt ? ` · 下次 ${formatDateTime(scheduler.probe.nextAt)}` : ''}
                  {summary ? ` · 上轮 ${summary.available}/${summary.total} 可用` : ''}
                </span>
                {scheduler?.probe.lastOk === false && scheduler.probe.lastError && (
                  <span className="text-bad small">上次入队失败：{scheduler.probe.lastError}</span>
                )}
              </div>
            </div>
            <div className="schedule-item">
              <div>
                <strong>自动发现</strong>
                <span className="muted">
                  {scheduler?.discovery?.enabled === false
                    ? '已关闭'
                    : `每 ${scheduler?.discovery?.intervalHours ?? 12} 小时`}
                  {scheduler?.discovery?.nextAt ? ` · 下次 ${formatDateTime(scheduler.discovery.nextAt)}` : ''}
                </span>
                {scheduler?.discovery?.lastOk === false && scheduler.discovery.lastError && (
                  <span className="text-bad small">上次入队失败：{scheduler.discovery.lastError}</span>
                )}
              </div>
            </div>
            <div className="schedule-item">
              <div>
                <strong>代理测活</strong>
                <span className="muted">
                  {scheduler?.proxyTest.enabled === false ? '已关闭' : `每 ${scheduler?.proxyTest.intervalHours ?? 6} 小时`}
                  {scheduler?.proxyTest.nextAt ? ` · 下次 ${formatDateTime(scheduler.proxyTest.nextAt)}` : ''}
                </span>
                {scheduler?.proxyTest.lastOk === false && scheduler.proxyTest.lastError && (
                  <span className="text-bad small">上次入队失败：{scheduler.proxyTest.lastError}</span>
                )}
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
            <Link to="/runs">全部运行</Link>
            <a href="https://github.com/fade09675/lx-source-watch/actions" target="_blank" rel="noreferrer">
              GitHub Actions
            </a>
          </div>
        </div>
        {runs.length === 0 ? (
          <p className="muted">还没有运行记录。</p>
        ) : (
          <div className="table-wrap">
            <table className="data-table run-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>状态</th>
                  <th>触发</th>
                  <th>源</th>
                  <th>平台</th>
                  <th>耗时</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => {
                  const state = runStatus(run);
                  return (
                    <tr key={run.id}>
                      <td className="muted">{formatDateTime(run.finishedAt)}</td>
                      <td>
                        <span className={`pill tone-${runTone(state)}`}>{RUN_STATUS_LABEL[state] ?? state}</span>
                      </td>
                      <td className="muted">{triggerLabel(run.trigger)}</td>
                      <td>
                        <span className="text-ok">{run.available}</span> / {run.partial} /{' '}
                        <span className="text-bad">{run.unavailable}</span> / {run.untested}
                        <span className="muted small">（共 {run.total}）</span>
                      </td>
                      <td className="mono">
                        {run.platformsOk}/{run.platformsTested}
                      </td>
                      <td className="mono">{formatDuration(run.durationMs)}</td>
                      <td>
                        <Link to={`/runs/${run.id}`}>{run.logKey ? '日志' : '详情'}</Link>
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
