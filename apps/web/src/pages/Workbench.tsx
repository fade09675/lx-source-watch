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
import { Icon } from '../components/Icon';
import { Pagination, useClientPager } from '../components/Pagination';
import { StatusBadge } from '../components/ui';

const TASK_TYPE_LABEL: Record<TaskType, string> = {
  probe: '音源探测',
  discovery: '自动发现',
  'source-test': '单源测试',
  'proxy-test': '代理测活',
  'proxy-fetch-sub': '拉取订阅',
  retention: '数据清理',
  'cn-probe': '国内补测',
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
  system: '系统',
  local: '本地',
};

const RUNNER_LABEL: Record<string, string> = {
  'github-actions': 'GitHub Actions',
  local: '本地运行',
  manual: '手动',
};

function pct(value: number, max: number): number {
  if (!Number.isFinite(value) || max <= 0) return 0;
  return Math.max(0, Math.min(100, (value / max) * 100));
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

function statusTone(status: TaskStatus): 'ok' | 'warn' | 'bad' | 'idle' | 'accent' {
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
      { label: '可用', value: String(countValue(result, 'available')), tone: 'ok' },
      { label: '部分', value: String(countValue(result, 'partial')), tone: 'warn' },
      { label: '失效', value: String(countValue(result, 'unavailable')), tone: 'bad' },
      { label: '未测', value: String(countValue(result, 'untested')) },
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
  } else if (result.kind === 'cn-probe') {
    items.push(
      { label: '候选', value: String(countValue(result, 'selected')) },
      { label: '实测', value: String(countValue(result, 'tested')) },
      { label: '可达', value: String(countValue(result, 'ok')), tone: 'ok' },
      { label: '失败', value: String(countValue(result, 'failed')), tone: 'bad' },
      { label: '源', value: String(countValue(result, 'sources')) },
      { label: '接入点', value: String(countValue(result, 'endpoints')) },
    );
  } else if (result.kind === 'retention') {
    items.push(
      { label: '运行', value: String(countValue(result, 'runs')) },
      { label: '接入点', value: String(countValue(result, 'sourceEndpoints')) },
      { label: '日汇总', value: `${countValue(result, 'sourceDaily')}/${countValue(result, 'platformDaily')}` },
      { label: '事件', value: String(countValue(result, 'events')) },
      { label: '操作记录', value: String(countValue(result, 'activity')) },
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
  const failedSources = result.failedSources ?? [];
  const partialSources = result.partialSources ?? [];
  const okSources = result.okSources ?? [];
  const failedPlatforms = result.failedPlatforms ?? [];
  const okPlatforms = result.okPlatforms ?? [];
  const subscriptions = result.subscriptions ?? [];
  const cnFailures = result.cnFailures ?? [];
  if (
    failedSources.length === 0 &&
    partialSources.length === 0 &&
    okSources.length === 0 &&
    failedPlatforms.length === 0 &&
    okPlatforms.length === 0 &&
    subscriptions.length === 0 &&
    cnFailures.length === 0
  ) {
    return null;
  }
  const count = (key: string) => result.counts[key] ?? 0;
  const renderSources = (items: TaskResult['failedSources'], label: string, total: number) =>
    items && items.length > 0 ? (
      <details className="task-detail" open>
        <summary>
          {label}（{items.length < total ? `列出 ${items.length} / 共 ${total}` : total}）
        </summary>
        <ul>
          {items.map((source) => (
            <li key={source.id}>
              <Link to={`/s/${encodeURIComponent(source.id)}`}>{source.title}</Link>
              <span className="muted small"> · {source.status}</span>
              {source.error && <span className="text-bad small"> · {source.error}</span>}
            </li>
          ))}
        </ul>
      </details>
    ) : null;
  const renderPlatforms = (items: TaskResult['failedPlatforms'], label: string, total: number) =>
    items && items.length > 0 ? (
      <details className="task-detail" open>
        <summary>
          {label}（{items.length < total ? `列出 ${items.length} / 共 ${total}` : total}）
        </summary>
        <ul>
          {items.map((platform, index) => (
            <li key={`${platform.sourceId}-${platform.name}-${index}`}>
              {platform.name}
              {platform.errorKind && <span className="muted small"> · {platform.errorKind}</span>}
              {platform.error && <span className="text-bad small"> · {platform.error}</span>}
            </li>
          ))}
        </ul>
      </details>
    ) : null;
  return (
    <div className="task-result-details">
      {renderSources(failedSources, '失效的源', count('unavailable'))}
      {renderSources(partialSources, '部分或未测的源', count('partial') + count('untested'))}
      {renderSources(okSources, '通过的源', count('available'))}
      {renderPlatforms(failedPlatforms, '失败的平台', Math.max(0, count('platformsTested') - count('platformsOk')))}
      {renderPlatforms(okPlatforms, '通过的平台', count('platformsOk'))}
      {subscriptions.length > 0 && (
        <details className="task-detail" open>
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
      {cnFailures.length > 0 && (
        <details className="task-detail" open>
          <summary>国内补测失败（{cnFailures.length}）</summary>
          <ul>
            {cnFailures.map((item, index) => (
              <li key={`${item.sourceId}-${item.kind}-${index}`}>
                {item.sourceTitle ?? item.sourceId}
                <span className="muted small"> · {item.kind === 'platform' ? item.platform : item.url}</span>
                {item.error && <span className="text-bad small"> · {item.error}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function taskHasDetail(result: TaskResult): boolean {
  return Boolean(
    (result.failedSources?.length ?? 0) +
      (result.partialSources?.length ?? 0) +
      (result.okSources?.length ?? 0) +
      (result.failedPlatforms?.length ?? 0) +
      (result.okPlatforms?.length ?? 0) +
      (result.subscriptions?.length ?? 0) +
      (result.cnFailures?.length ?? 0) > 0,
  );
}

function TaskRow({ task }: { task: TaskView }) {
  const result = task.result;
  return (
    <li className="task-row">
      <div className="task-row-status">
        <StatusBadge tone={statusTone(task.status)}>{TASK_STATUS_LABEL[task.status] ?? task.status}</StatusBadge>
      </div>
      <div className="task-row-main">
        <div className="task-row-head">
          <strong>{taskType(task)}</strong>
          <span className="task-trigger">{TRIGGER_LABEL[task.source] ?? task.source}</span>
          <span className="task-row-time">{formatDateTime(task.finishedAt ?? task.createdAt)}</span>
        </div>
        <p className="task-row-summary">{result?.summary || task.message || '无结果摘要'}</p>
        {result && <ResultStats result={result} />}
        {task.error && <p className="text-bad small">{task.error}</p>}
        {result && taskHasDetail(result) && (
          <details className="task-row-details">
            <summary>查看失败明细</summary>
            <TaskFailureDetails result={result} />
          </details>
        )}
        {result?.warnings && result.warnings.length > 0 && (
          <p className="muted small">提示：{result.warnings.join('；')}</p>
        )}
      </div>
      <div className="task-row-side">
        <span className="task-row-duration">耗时 {taskElapsed(task)}</span>
        {task.runId && <Link to={`/runs/${task.runId}`}>运行详情</Link>}
        {task.runId && <Link to={`/runs/${task.runId}?tab=logs`}>日志</Link>}
      </div>
    </li>
  );
}

function RunningTask({ task, busy, onCancel }: { task: TaskView; busy: boolean; onCancel: () => void }) {
  const percent = task.progress.total > 0 ? Math.round((task.progress.done / task.progress.total) * 100) : 0;
  return (
    <li className="compact-task">
      <span className="compact-task-icon run">
        <Icon name="pulse" size={16} />
      </span>
      <div className="compact-task-main">
        <div className="compact-task-head">
          <strong>{taskType(task)}</strong>
          <span className="task-trigger">{TRIGGER_LABEL[task.source] ?? task.source}</span>
          <span className="muted small">{task.message || '已派发，等待执行'}</span>
        </div>
        <div className="compact-task-meta">
          <span>耗时 {taskElapsed(task)}</span>
          {task.runId && <Link to={`/runs/${task.runId}`}>运行记录</Link>}
        </div>
        {task.progress.total > 0 && (
          <div className="meter">
            <span style={{ width: `${percent}%` }} />
          </div>
        )}
      </div>
      <button type="button" className="link-button danger" onClick={onCancel} disabled={busy}>
        取消
      </button>
    </li>
  );
}

function QueuedTask({ task, busy, onCancel }: { task: TaskView; busy: boolean; onCancel: () => void }) {
  return (
    <li className="compact-task">
      <span className="compact-task-icon queue">
        <Icon name="runs" size={16} />
      </span>
      <div className="compact-task-main">
        <div className="compact-task-head">
          <strong>{taskType(task)}</strong>
          <span className="task-trigger">{TRIGGER_LABEL[task.source] ?? task.source}</span>
          <span className="muted small">P{task.priority}</span>
        </div>
        <div className="compact-task-meta">
          <span>{formatRelative(task.createdAt)}</span>
          {task.payload.limit ? <span>最多 {task.payload.limit} 源</span> : null}
        </div>
      </div>
      <button type="button" className="link-button danger" onClick={onCancel} disabled={busy}>
        取消
      </button>
    </li>
  );
}

export function WorkbenchPage() {
  const [status, setStatus] = useState<StatusEnvelope | null>(null);
  const [health, setHealth] = useState<Awaited<ReturnType<typeof api.health>> | null>(null);
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
  const [hubTab, setHubTab] = useState<'recent' | 'activity'>('recent');
  const [error, setError] = useState('');
  const [action, setAction] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [cnLimit, setCnLimit] = useState(200);
  const [loaded, setLoaded] = useState(false);

  const loadOverview = useCallback(async () => {
    // 汇总数据走精简接口；先让指标出现，额度/调度/任务状态随后补齐，避免首屏被慢接口拖住。
    const statusPromise = api.overview();
    const restPromise = Promise.all([
      api.health(),
      api.usage().then((result) => result.usage).catch(() => null),
      api.system(),
      api.tasks({ status: 'running', limit: 10 }),
      api.tasks({ status: 'queued', limit: 100 }),
    ]);

    statusPromise
      .then(setStatus)
      .catch((err) => setError(err instanceof ApiError ? err.message : '加载工作台失败'))
      .finally(() => setLoaded(true));

    restPromise
      .then(([healthResult, usageResult, systemResult, runningResult, queuedResult]) => {
        setHealth(healthResult);
        setUsage(usageResult);
        setSystem(systemResult);
        setRunning(runningResult.tasks);
        setQueued(queuedResult.tasks);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : '加载工作台失败'));

    await statusPromise.catch(() => undefined);
  }, []);

  const loadRecent = useCallback(async () => {
    try {
      const result = await api.tasks({
        status: 'finished',
        type: recentType || undefined,
        limit: recentPage.limit,
        offset: recentPage.offset,
      });
      setRecent(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '加载最近任务失败');
    }
  }, [recentPage, recentType]);

  const loadActivity = useCallback(async () => {
    try {
      const result = await api.activity(activityPage.limit, activityPage.offset);
      setActivity(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '加载操作记录失败');
    }
  }, [activityPage]);

  const load = useCallback(async () => {
    setError('');
    await Promise.all([loadOverview(), loadRecent(), loadActivity()]);
  }, [loadOverview, loadRecent, loadActivity]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  useEffect(() => {
    void loadRecent();
  }, [loadRecent]);

  useEffect(() => {
    if (hubTab === 'activity') void loadActivity();
  }, [hubTab, loadActivity]);

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

  async function runCnProbeNow() {
    const probeRunId = snapshot?.runId;
    if (!probeRunId) {
      setAction('还没有可用的探测运行，先跑一轮探测。');
      return;
    }
    setBusy('cn-probe');
    setAction('');
    try {
      const result: CreateTaskResult = await api.createTask({
        type: 'cn-probe',
        payload: { probeRunId, limit: cnLimit },
      });
      const message = result.dispatch.dispatched
        ? '已派发国内补测任务，约 2–3 分钟后刷新可看到结果。'
        : `国内补测任务已入队：${result.dispatch.message ?? '等待派发'}`;
      setAction(message);
      window.setTimeout(() => void load(), 3000);
    } catch (err) {
      setAction(err instanceof ApiError ? err.message : '创建国内补测任务失败');
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

  const snapshot = status?.snapshot;
  const summary = snapshot?.summary;
  const counts = recent?.counts ?? {
    queued: 0,
    running: 0,
    succeeded: 0,
    partial: 0,
    failed: 0,
    cancelled: 0,
  };
  const scheduler = system?.scheduler;
  const runCounts = health?.lastRun?.counts;
  const total = summary?.total ?? 0;
  const coverage = [
    { key: 'available', label: '可用', value: summary?.available ?? 0, tone: 'ok' },
    { key: 'partial', label: '部分', value: summary?.partial ?? 0, tone: 'warn' },
    { key: 'unavailable', label: '失效', value: summary?.unavailable ?? 0, tone: 'bad' },
    { key: 'untested', label: '未测', value: summary?.untested ?? 0, tone: 'idle' },
  ];
  const metrics = [
    {
      key: 'sources',
      label: '音源总数',
      value: String(total),
      unit: '个',
      hint: `可用 ${summary?.available ?? 0} · 部分 ${summary?.partial ?? 0} · 失效 ${summary?.unavailable ?? 0}`,
      tone: 'accent',
    },
    {
      key: 'platforms',
      label: '平台通过',
      value: `${summary?.platformsOk ?? 0}/${summary?.platformsTested ?? 0}`,
      hint: '本轮已测平台',
      tone: 'ok',
    },
    {
      key: 'endpoints',
      label: '接入点通过',
      value: runCounts ? `${runCounts.endpointsOk}/${runCounts.endpointsTotal}` : '—',
      hint: '主地址与镜像',
      tone: 'ok',
    },
    {
      key: 'cn',
      label: '国内可达',
      value: runCounts ? `${runCounts.cnOk}/${runCounts.cnTested}` : '—',
      hint: '经国内代理补测',
      tone: 'warn',
    },
    {
      key: 'candidates',
      label: '候选音源',
      value: String(health?.candidates ?? 0),
      hint: '待审核与已转正',
      tone: 'accent',
    },
  ];
  const schedules = [
    {
      key: 'probe',
      label: '音源探测',
      icon: 'sources' as const,
      state: scheduler?.probe,
      interval: scheduler?.probe.intervalHours ?? 4,
    },
    {
      key: 'discovery',
      label: '自动发现',
      icon: 'candidate' as const,
      state: scheduler?.discovery,
      interval: scheduler?.discovery?.intervalHours ?? 12,
    },
    {
      key: 'proxy-test',
      label: '代理测活',
      icon: 'proxy' as const,
      state: scheduler?.proxyTest,
      interval: scheduler?.proxyTest.intervalHours ?? 6,
    },
    {
      key: 'cn-probe',
      label: '国内补测',
      icon: 'pulse' as const,
      state: undefined,
      interval: 0,
      auto: '探测后自动',
    },
    {
      key: 'retention',
      label: '数据清理',
      icon: 'database' as const,
      state: scheduler?.retention,
      interval: scheduler?.retention?.intervalHours ?? 24,
    },
  ];
  const quickLinks = [
    { to: '/sources', label: '音源总览', icon: 'sources' as const },
    { to: '/candidates', label: '候选音源', icon: 'candidate' as const },
    { to: '/runs', label: '运行与日志', icon: 'runs' as const },
    { to: '/admin/proxies', label: '国内代理', icon: 'proxy' as const },
    { to: '/admin/settings', label: '设置', icon: 'settings' as const },
  ];

  return (
    <div className="page dash-page">
      <section className="dash-hero">
        <div className="dash-hero-copy">
          <span className="dash-eyebrow">OVERVIEW · 音源监测</span>
          <h1>概览</h1>
          <p>音源脚本、平台取链与国内可达性一屏汇总。</p>
          <div className="dash-hero-meta">
            <span className={`dash-live ${status?.stale ? 'stale' : 'ok'}`}>
              <i />
              {status?.stale ? '数据已过期' : '数据正常'}
            </span>
            {snapshot && <span>上次 {formatRelative(snapshot.generatedAt)}</span>}
            {snapshot && <span>下轮 {formatDateTime(snapshot.nextCheckAt)}</span>}
            {snapshot && <span>本轮 {formatDuration(snapshot.durationMs)}</span>}
            <span>候选 {health?.candidates ?? 0}</span>
          </div>
        </div>
        <div className="dash-hero-actions">
          <button type="button" className="dash-action primary" onClick={() => void runTask('probe')} disabled={busy !== null}>
            <Icon name="pulse" size={16} />
            {busy === 'probe' ? '创建中…' : '立即探测'}
          </button>
          <button type="button" className="dash-action" onClick={() => void dispatchQueued()} disabled={busy !== null}>
            派发排队
          </button>
          <button type="button" className="dash-action icon" onClick={() => void load()} disabled={!loaded} aria-label="刷新">
            <Icon name="refresh" size={17} />
          </button>
        </div>
      </section>

      <div className="dash-metrics">
        {metrics.map((metric) => (
          <article className={`dash-metric tone-${metric.tone}`} key={metric.key}>
            <span className="dash-metric-label">{metric.label}</span>
            <strong className="dash-metric-value">
              {metric.value}
              {metric.unit ? <small>{metric.unit}</small> : null}
            </strong>
            <span className="dash-metric-hint">{metric.hint}</span>
          </article>
        ))}
      </div>

      {error && <ErrorBox message={error} />}
      {!loaded && !error && <Spinner label="正在加载工作台…" />}

      {action && (
        <div className="dash-toast">
          <span>{action}</span>
          <button type="button" className="link-button" onClick={() => setAction('')}>
            收起
          </button>
        </div>
      )}

      <div className="dash-content">
        <div>
          <section className="dash-card task-hub">
            <header className="dash-card-head task-hub-head">
              <div>
                <h2>任务中心</h2>
                <p>
                  运行 {counts.running} · 排队 {counts.queued} · 成功 {counts.succeeded} · 部分 {counts.partial} · 失败{' '}
                  {counts.failed} · 取消 {counts.cancelled}
                </p>
              </div>
              <div className="dash-card-actions">
                <button type="button" className="ghost-button small" onClick={() => void runTask('proxy-test')} disabled={busy !== null}>
                  {busy === 'proxy-test' ? '创建中…' : '立即测活'}
                </button>
                <button type="button" className="ghost-button small" onClick={() => void runTask('discovery')} disabled={busy !== null}>
                  {busy === 'discovery' ? '创建中…' : '立即发现'}
                </button>
                <button type="button" className="ghost-button small" onClick={() => void reap()} disabled={busy !== null}>
                  清理卡死
                </button>
              </div>
            </header>

            <div className="task-lanes">
              <div className="task-lane">
                <div className="task-lane-head">
                  <h3>
                    <span className="lane-dot live" />
                    正在运行
                  </h3>
                  <span>{running.length > 0 ? `${running.length} 个` : '空闲'}</span>
                </div>
                {running.length === 0 ? (
                  <p className="task-lane-empty">当前没有运行中的任务。</p>
                ) : (
                  <ul className="compact-task-list">
                    {running.map((task) => (
                      <RunningTask key={task.id} task={task} busy={busy !== null} onCancel={() => void cancel(task)} />
                    ))}
                  </ul>
                )}
              </div>

              <div className="task-lane">
                <div className="task-lane-head">
                  <h3>
                    <span className="lane-dot waiting" />
                    排队中
                  </h3>
                  <span>{queued.length > 0 ? `${queued.length} 个` : '空'}</span>
                </div>
                {queued.length === 0 ? (
                  <p className="task-lane-empty">队列为空。</p>
                ) : (
                  <ul className="compact-task-list">
                    {queuedPager.pageItems.map((task) => (
                      <QueuedTask key={task.id} task={task} busy={busy !== null} onCancel={() => void cancel(task)} />
                    ))}
                  </ul>
                )}
                {queued.length > 0 && <Pagination {...queuedPager.pagination} label="个任务" />}
              </div>
            </div>

            <div className="schedule-strip">
              <div className="schedule-strip-title">
                <Icon name="pulse" size={15} />
                <span>定时计划</span>
              </div>
              <div className="schedule-chips">
                {schedules.map((schedule) => (
                  <div className={`schedule-chip ${schedule.state?.enabled === false ? 'off' : ''}`} key={schedule.key}>
                    <Icon name={schedule.icon} size={15} />
                    <div className="schedule-chip-copy">
                      <strong>{schedule.label}</strong>
                      <span>
                        {'auto' in schedule
                          ? schedule.auto
                          : schedule.state?.enabled === false
                            ? '已关闭'
                            : `每 ${schedule.interval} 小时`}
                        {schedule.state?.nextAt ? ` · 下次 ${formatDateTime(schedule.state.nextAt)}` : ''}
                      </span>
                      <span className={`schedule-chip-last ${schedule.state?.lastOk === false ? 'bad' : ''}`}>
                        {'auto' in schedule
                          ? '由每次探测完成触发'
                          : schedule.state?.lastAt
                            ? `上次定时 ${schedule.state.lastOk === false ? '失败' : '成功'} · ${formatRelative(schedule.state.lastAt)}`
                            : '上次定时 未运行'}
                      </span>
                    </div>
                    {schedule.key === 'cn-probe' ? (
                      <>
                        <select
                          className="schedule-chip-select"
                          value={cnLimit}
                          onChange={(event) => setCnLimit(Number(event.target.value))}
                          disabled={busy !== null}
                          aria-label="手动补测条数上限"
                          title="立即补测最多测试多少条"
                        >
                          <option value={20}>20 条</option>
                          <option value={50}>50 条</option>
                          <option value={100}>100 条</option>
                          <option value={200}>200 条</option>
                        </select>
                        <button
                          type="button"
                          className="link-button"
                          onClick={() => void runCnProbeNow()}
                          disabled={busy !== null || !snapshot?.runId}
                          title={snapshot?.runId ? `基于 ${snapshot.runId} 立即补测` : '还没有可用的探测运行'}
                        >
                          {busy === 'cn-probe' ? '创建中…' : '立即补测'}
                        </button>
                      </>
                    ) : schedule.key === 'retention' ? (
                      <span className="muted small">自动</span>
                    ) : (
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => void runTask(schedule.key as TaskType)}
                        disabled={busy !== null}
                      >
                        立即执行
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>

            <div className="hub-tabs" role="tablist" aria-label="任务中心视图">
              <button
                type="button"
                role="tab"
                aria-selected={hubTab === 'recent'}
                className={hubTab === 'recent' ? 'active' : ''}
                onClick={() => setHubTab('recent')}
              >
                最近任务
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={hubTab === 'activity'}
                className={hubTab === 'activity' ? 'active' : ''}
                onClick={() => setHubTab('activity')}
              >
                操作记录
              </button>
              <span className="hub-tabs-spacer" />
              {hubTab === 'recent' && (
              <select
                className="select hub-select"
                value={recentType}
                onChange={(event) => {
                  setRecentType(event.target.value as TaskType | '');
                  setRecentPage((prev) => ({ ...prev, offset: 0 }));
                }}
                aria-label="任务类型"
              >
                <option value="">全部类型</option>
                {Object.entries(TASK_TYPE_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              )}
              <Link className="panel-link" to="/runs">
                全部运行 <Icon name="chevron-right" size={14} />
              </Link>
            </div>

            {hubTab === 'recent' ? (
            <div className="task-recent">
              {!recent || recent.tasks.length === 0 ? (
                <p className="task-lane-empty">还没有已完成的任务。</p>
              ) : (
                <ul className="task-rows">
                  {recent.tasks.map((task) => (
                    <TaskRow key={task.id} task={task} />
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
            </div>
            ) : (
            <div className="task-activity">
              {!activity || activity.items.length === 0 ? (
                <p className="task-lane-empty">还没有操作记录。</p>
              ) : (
                <div className="table-wrap">
                  <table className="data-table compact-table activity-table">
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
                          <td className="mono small">
                            {item.target ? (item.target.startsWith('task_') ? `任务 ${item.target}` : item.target) : '—'}
                          </td>
                          <td>
                            <StatusBadge tone={item.ok ? 'ok' : 'bad'} dot={false}>
                              {item.ok ? '成功' : `失败 ${item.status}`}
                            </StatusBadge>
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
            </div>
            )}
          </section>
        </div>

        <section className="dash-card quota-section">
            <header className="rail-head">
              <h3>额度与配额</h3>
              <button type="button" className="link-button" onClick={() => void refreshUsage()} disabled={busy === 'usage'}>
                刷新
              </button>
            </header>
            {usage ? (
              <div className="quota-grid">
                {usageCards(usage).map((card) => (
                  <div className="quota-card" key={card.key}>
                    <div className="quota-card-head">
                      <span className="quota-card-icon">
                        <Icon name={card.key === 'actions' ? 'pulse' : 'database'} size={15} />
                      </span>
                      <span>{card.label}</span>
                    </div>
                    <strong className="quota-card-value">
                      {card.value.toLocaleString('zh-CN')}
                      {card.max > 0 && <small> / {card.max.toLocaleString('zh-CN')}</small>}
                    </strong>
                    {card.max > 0 && (
                      <div className="quota-meter">
                        <span style={{ width: `${pct(card.value, card.max)}%` }} />
                      </div>
                    )}
                    <span className="quota-hint">{card.hint}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="muted small">额度数据暂不可用。</p>
            )}
            {usage?.cloudflareError && (
              <p className="rail-note">
                Cloudflare 统计不可用：{usage.cloudflareError}
              </p>
            )}
        </section>

        <div className="dash-duo">
          <section className="dash-card bottom-card">
            <header className="rail-head">
              <h3>轮次覆盖</h3>
              <span className="muted small">{total} 个音源</span>
            </header>
            <div className="coverage-bar" aria-hidden="true">
              {coverage.map((item) =>
                item.value > 0 ? (
                  <span
                    key={item.key}
                    className={`coverage-${item.tone}`}
                    style={{ width: `${pct(item.value, total)}%` }}
                  />
                ) : null,
              )}
            </div>
            <div className="coverage-legend">
              {coverage.map((item) => (
                <span key={item.key} className={`coverage-legend-${item.tone}`}>
                  <i />
                  {item.label}
                  <strong>{item.value}</strong>
                </span>
              ))}
            </div>
            <dl className="rail-facts">
              <div>
                <dt>平台</dt>
                <dd>{summary ? `${summary.platformsOk}/${summary.platformsTested}` : '—'}</dd>
              </div>
              <div>
                <dt>接入点</dt>
                <dd>{runCounts ? `${runCounts.endpointsOk}/${runCounts.endpointsTotal}` : '—'}</dd>
              </div>
              <div>
                <dt>国内补测</dt>
                <dd>{runCounts ? `${runCounts.cnOk}/${runCounts.cnTested}` : '—'}</dd>
              </div>
              <div>
                <dt>候选</dt>
                <dd>{health?.candidates ?? 0}</dd>
              </div>
            </dl>
          </section>

          <section className="dash-card rail-card">
            <header className="rail-head">
              <h3>快捷入口</h3>
            </header>
            <div className="quick-links">
              {quickLinks.map((link) => (
                <Link key={link.to} to={link.to}>
                  <span className="quick-link-icon">
                    <Icon name={link.icon} size={16} />
                  </span>
                  <span>{link.label}</span>
                  <Icon name="chevron-right" size={14} />
                </Link>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
