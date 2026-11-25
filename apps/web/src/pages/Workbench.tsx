import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { formatDateTime, formatDuration, formatRelative, type StatusEnvelope } from '@lx/shared';
import {
  ApiError,
  api,
  type ActivityListResult,
  type CreateTaskResult,
  type SystemView,
  type TaskListResult,
  type TaskResult,
  type TaskStatus,
  type TaskType,
  type TaskView,
  type UsageView,
} from '../api';
import { ErrorBox, Spinner } from '../components/Feedback';
import { Pagination, useClientPager } from '../components/Pagination';

const TASK_TYPE_LABEL: Record<TaskType, string> = {
  probe: '音源探测',
  discovery: '自动发现',
  'source-test': '单源测试',
  'proxy-test': '代理测活',
  'proxy-fetch-sub': '拉取订阅',
};

const TASK_STATUS_LABEL: Record<string, string> = {
  queued: '排队中',
  running: '运行中',
  succeeded: '成功',
  partial: '部分成功',
  failed: '失败',
  cancelled: '已取消',
};

const TRIGGER_LABEL: Record<string, string> = {
  schedule: '定时',
  manual: '手动',
  api: '接口',
  retry: '重试',
  local: '本地',
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

function statusTone(status: TaskStatus): string {
  if (status === 'succeeded') return 'ok';
  if (status === 'partial' || status === 'running') return 'warn';
  if (status === 'queued') return 'idle';
  return 'bad';
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

function countValue(result: TaskResult | undefined, key: string): number {
  return result?.counts[key] ?? 0;
}

function ResultStats({ result }: { result: TaskResult }) {
  const items: Array<{ label: string; value: string; tone?: string }> = [];
  if (result.kind === 'probe' || result.kind === 'source-test') {
    items.push(
      { label: '源', value: `${countValue(result, 'available')} 可用 / ${countValue(result, 'partial')} 部分 / ${countValue(result, 'unavailable')} 失效 / ${countValue(result, 'untested')} 未测` },
      { label: '平台', value: `${countValue(result, 'platformsOk')}/${countValue(result, 'platformsTested')}` },
      { label: '接入点', value: `${countValue(result, 'endpointsOk')}/${countValue(result, 'endpointsTotal')}` },
      { label: '国内', value: `${countValue(result, 'cnOk')}/${countValue(result, 'cnTested')}` },
    );
  } else if (result.kind === 'proxy-test') {
    items.push(
      { label: '节点', value: String(countValue(result, 'proxyTotal')) },
      { label: '可用', value: String(countValue(result, 'proxyOk')), tone: 'ok' },
      { label: '失败', value: String(countValue(result, 'proxyFail')), tone: 'bad' },
      { label: '内核', value: String(countValue(result, 'kernelOk')) },
      { label: '跳过 UDP', value: String(countValue(result, 'skippedUdp')) },
      { label: '耗时', value: formatDuration(countValue(result, 'durationMs')) },
    );
  } else if (result.kind === 'discovery') {
    items.push(
      { label: '新增候选', value: String(countValue(result, 'candidatesAdded')) },
      { label: '自动转正', value: String(countValue(result, 'candidatesPromoted')), tone: 'ok' },
    );
  } else if (result.kind === 'proxy-fetch-sub') {
    items.push(
      { label: '新增', value: String(countValue(result, 'added')) },
      { label: '更新', value: String(countValue(result, 'updated')) },
      { label: '节点总数', value: String(countValue(result, 'total')) },
    );
  }
  return (
    <div className="task-result-stats">
      {items.map((item) => (
        <span key={item.label} className="task-result-stat">
          <span className="muted small">{item.label}</span>
          <strong className={item.tone ? `text-${item.tone}` : undefined}>{item.value}</strong>
        </span>
      ))}
    </div>
  );
}

function TaskFailureDetails({ result }: { result: TaskResult }) {
  const sources = result.failedSources ?? [];
  const platforms = result.failedPlatforms ?? [];
  const subscriptions = result.subscriptions ?? [];
  if (sources.length === 0 && platforms.length === 0 && subscriptions.length === 0) return null;
  return (
    <div className="task-result-details">
      {sources.length > 0 && (
        <details>
          <summary>失败的源（{sources.length}）</summary>
          <ul>
            {sources.map((source) => (
              <li key={source.id}>
                <Link to={`/sources/${encodeURIComponent(source.id)}`}>{source.title}</Link>
                <span className="muted small"> · {source.status}</span>
                {source.error && <span className="text-bad small"> · {source.error}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
      {platforms.length > 0 && (
        <details>
          <summary>失败的平台（{platforms.length}）</summary>
          <ul>
            {platforms.map((platform, index) => (
              <li key={`${platform.sourceId}-${platform.name}-${index}`}>
                {platform.name}
                {platform.errorKind && <span className="muted small"> · {platform.errorKind}</span>}
                {platform.error && <span className="text-bad small"> · {platform.error}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
      {subscriptions.length > 0 && (
        <details>
          <summary>按订阅统计（{subscriptions.length}）</summary>
          <table className="mini-table">
            <thead>
              <tr>
                <th>订阅</th>
                <th>节点</th>
                <th>可用</th>
                <th>失败</th>
              </tr>
            </thead>
            <tbody>
              {subscriptions.map((sub, index) => (
                <tr key={`${sub.id ?? sub.name}-${index}`}>
                  <td>{sub.name}</td>
                  <td className="mono">{sub.total}</td>
                  <td className="mono text-ok">{sub.ok}</td>
                  <td className="mono text-bad">{sub.fail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}

function TaskCard({ task }: { task: TaskView }) {
  const result = task.result;
  return (
    <li className="task-card">
      <div className="task-card-head">
        <span className={`pill tone-${statusTone(task.status)}`}>{TASK_STATUS_LABEL[task.status] ?? task.status}</span>
        <strong>{taskType(task)}</strong>
        <span className="badge">{TRIGGER_LABEL[task.source] ?? task.source}</span>
        <span className="muted small">{formatDateTime(task.finishedAt ?? task.createdAt)}</span>
        <span className="muted small">耗时 {taskElapsed(task)}</span>
      </div>
      <div className="task-card-body">
        <p className="task-card-summary">{result?.summary || task.message || '无结果摘要'}</p>
        {result && <ResultStats result={result} />}
        {task.error && <p className="text-bad small">{task.error}</p>}
        {result && <TaskFailureDetails result={result} />}
        {result?.warnings && result.warnings.length > 0 && (
          <p className="muted small">提示：{result.warnings.join('；')}</p>
        )}
      </div>
      <div className="task-card-foot">
        {task.runId && <Link to={`/runs/${task.runId}`}>运行详情</Link>}
        {task.runId && <Link to={`/runs/${task.runId}?tab=logs`}>日志</Link>}
        <span className="muted small mono">{task.id}</span>
      </div>
    </li>
  );
}

export function WorkbenchPage() {
  const [status, setStatus] = useState<StatusEnvelope | null>(null);
  const [usage, setUsage] = useState<UsageView | null>(null);
  const [system, setSystem] = useState<SystemView | null>(null);
  const [running, setRunning] = useState<TaskView[]>([]);
  const [queued, setQueued] = useState<TaskView[]>([]);
  const queuedPager = useClientPager(queued);
  const [recent, setRecent] = useState<TaskListResult | null>(null);
  const [activity, setActivity] = useState<ActivityListResult | null>(null);
  const [recentPage, setRecentPage] = useState({ limit: 10, offset: 0 });
  const [activityPage, setActivityPage] = useState({ limit: 10, offset: 0 });
  const [recentType, setRecentType] = useState<TaskType | ''>('');
  const [tab, setTab] = useState<'recent' | 'activity'>('recent');
  const [error, setError] = useState('');
  const [action, setAction] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      const recentLimit = recentPage.limit;
      const activityLimit = activityPage.limit;
      const [statusResult, usageResult, systemResult, runningResult, queuedResult, recentResult, activityResult] =
        await Promise.all([
          api.status(),
          api.usage(),
          api.system(),
          api.tasks({ status: 'running', limit: 10 }),
          api.tasks({ status: 'queued', limit: 100 }),
          api.tasks({
            status: 'finished',
            type: recentType || undefined,
            limit: recentLimit,
            offset: recentPage.offset,
          }),
          api.activity(activityLimit, activityPage.offset),
        ]);
      setStatus(statusResult);
      setUsage(usageResult.usage);
      setSystem(systemResult);
      setRunning(runningResult.tasks);
      setQueued(queuedResult.tasks);
      setRecent(recentResult);
      setActivity(activityResult);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '加载工作台失败');
    } finally {
      setLoaded(true);
    }
  }, [recentPage, activityPage, recentType]);

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
  const counts = recent?.counts ?? {
    queued: 0,
    running: 0,
    succeeded: 0,
    partial: 0,
    failed: 0,
    cancelled: 0,
  };
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
            运行 {counts.running} · 排队 {counts.queued} · 成功 {counts.succeeded} · 部分 {counts.partial} · 失败{' '}
            {counts.failed} · 取消 {counts.cancelled}
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
                  const percent =
                    task.progress.total > 0 ? Math.round((task.progress.done / task.progress.total) * 100) : 0;
                  return (
                    <li key={task.id}>
                      <span className="pill run-in_progress">{TASK_STATUS_LABEL[task.status] ?? task.status}</span>
                      <div className="task-main">
                        <strong>{taskType(task)}</strong>
                        <span className="badge">{TRIGGER_LABEL[task.source] ?? task.source}</span>
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
                        <button
                          type="button"
                          className="link-button danger"
                          onClick={() => void cancel(task)}
                          disabled={busy !== null}
                        >
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
                {queuedPager.pageItems.map((task) => (
                  <li key={task.id}>
                    <span className="pill run-queued">P{task.priority}</span>
                    <div className="task-main">
                      <strong>{taskType(task)}</strong>
                      <span className="badge">{TRIGGER_LABEL[task.source] ?? task.source}</span>
                      <span className="muted">
                        {formatRelative(task.createdAt)}
                        {task.payload.limit ? ` · 最多 ${task.payload.limit} 源` : ''}
                      </span>
                    </div>
                    <div className="task-side">
                      <button
                        type="button"
                        className="link-button danger"
                        onClick={() => void cancel(task)}
                        disabled={busy !== null}
                      >
                        取消
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {queued.length > 0 && <Pagination {...queuedPager.pagination} label="个任务" />}
          </div>
        </div>

        <div className="panel task-panel">
          <div className="panel-head">
            <div className="tab-row">
              <button
                type="button"
                className={tab === 'recent' ? 'tab active' : 'tab'}
                onClick={() => setTab('recent')}
              >
                最近任务
              </button>
              <button
                type="button"
                className={tab === 'activity' ? 'tab active' : 'tab'}
                onClick={() => setTab('activity')}
              >
                操作记录
              </button>
            </div>
            <div className="panel-links">
              <Link to="/runs">全部运行</Link>
            </div>
          </div>

          {tab === 'recent' && (
            <>
              <div className="task-filter">
                <label className="field compact">
                  <span>任务类型</span>
                  <select
                    className="select"
                    value={recentType}
                    onChange={(event) => {
                      setRecentType(event.target.value as TaskType | '');
                      setRecentPage((prev) => ({ ...prev, offset: 0 }));
                    }}
                  >
                    <option value="">全部类型</option>
                    {Object.entries(TASK_TYPE_LABEL).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {!recent || recent.tasks.length === 0 ? (
                <p className="muted">还没有已完成的任务。</p>
              ) : (
                <ul className="task-card-list">
                  {recent.tasks.map((task) => (
                    <TaskCard key={task.id} task={task} />
                  ))}
                </ul>
              )}
              {recent && (
                <Pagination
                  total={recent.total}
                  limit={recentPage.limit}
                  offset={recentPage.offset}
                  onChange={setRecentPage}
                  label="个任务"
                />
              )}
            </>
          )}

          {tab === 'activity' && (
            <>
              {!activity || activity.items.length === 0 ? (
                <p className="muted">还没有操作记录。</p>
              ) : (
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>时间</th>
                        <th>操作</th>
                        <th>目标</th>
                        <th>结果</th>
                        <th>说明</th>
                      </tr>
                    </thead>
                    <tbody>
                      {activity.items.map((item) => (
                        <tr key={item.id}>
                          <td className="muted">{formatDateTime(item.at)}</td>
                          <td>{item.action}</td>
                          <td className="mono small">{item.target || '—'}</td>
                          <td>
                            <span className={`pill tone-${item.ok ? 'ok' : 'bad'}`}>
                              {item.ok ? '成功' : `失败 ${item.status}`}
                            </span>
                          </td>
                          <td className="muted small">{item.message || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {activity && (
                <Pagination
                  total={activity.total}
                  limit={activityPage.limit}
                  offset={activityPage.offset}
                  onChange={setActivityPage}
                  label="条操作"
                />
              )}
            </>
          )}
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
    </div>
  );
}
