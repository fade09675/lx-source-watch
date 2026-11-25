import { useEffect, useState, type FormEvent } from 'react';
import { formatDateTime, formatDuration, type EventItem, type HealthResponse, type MirrorTemplate, type RunSummary } from '@lx/shared';
import { ApiError, api, type RunPurgePreview, type WorkflowRunView } from '../api';
import { EmptyBox, ErrorBox, Spinner } from '../components/Feedback';
import { Pagination, useClientPager } from '../components/Pagination';

const EVENT_LABEL: Record<EventItem['type'], string> = {
  recovered: '恢复',
  degraded: '降级',
  failed: '持续失效',
  new: '新源',
  updated: '版本更新',
  merged: '重复合并',
};

const RUN_STATUS: Record<string, string> = {
  queued: '排队中',
  in_progress: '运行中',
  completed: '已完成',
  waiting: '等待中',
  requested: '已请求',
  pending: '等待中',
};

const RUN_CONCLUSION: Record<string, string> = {
  success: '成功',
  failure: '失败',
  cancelled: '已取消',
  skipped: '跳过',
  timed_out: '超时',
  action_required: '需处理',
};

export function AdminPage() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [events, setEvents] = useState<EventItem[] | null>(null);
  const [error, setError] = useState('');
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [ghRuns, setGhRuns] = useState<WorkflowRunView[]>([]);
  const [lastDispatchedAt, setLastDispatchedAt] = useState<string | null>(null);
  const [runLimit, setRunLimit] = useState('3');
  const [preferMirror, setPreferMirror] = useState(true);
  const [dispatching, setDispatching] = useState(false);
  const [runMessage, setRunMessage] = useState('');
  const [mirrorTemplates, setMirrorTemplates] = useState<MirrorTemplate[] | null>(null);
  const [mirrorCustom, setMirrorCustom] = useState(false);
  const [mirrorMessage, setMirrorMessage] = useState('');
  const [savingMirrors, setSavingMirrors] = useState(false);
  const [purgeDays, setPurgeDays] = useState('30');
  const [purgePreview, setPurgePreview] = useState<RunPurgePreview | null>(null);
  const [purgeMessage, setPurgeMessage] = useState('');
  const [purging, setPurging] = useState(false);
  const runPager = useClientPager(runs ?? [], 10);
  const eventPager = useClientPager(events ?? [], 10);

  async function reloadHistory() {
    try {
      const result = await api.history(30);
      setRuns(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '读取运行记录失败');
    }
  }

  async function previewPurge() {
    const days = Number(purgeDays);
    if (!Number.isInteger(days) || days < 1) {
      setPurgeMessage('请输入大于 0 的整数天数');
      return;
    }
    setPurging(true);
    setPurgeMessage('');
    try {
      const result = await api.previewRunPurge(days);
      setPurgePreview(result.preview);
      setPurgeMessage(
        result.preview.runs === 0 && result.preview.proxyTestRuns === 0 ? '没有需要清理的记录。' : '',
      );
    } catch (err) {
      setPurgeMessage(err instanceof ApiError ? err.message : '预览失败');
    } finally {
      setPurging(false);
    }
  }

  async function confirmPurge() {
    if (!purgePreview) return;
    const ok = window.confirm(
      `确认删除 ${purgePreview.runs} 轮运行、${purgePreview.proxyTestRuns} 轮测活及对应明细？此操作不可恢复，最新一轮会保留。`,
    );
    if (!ok) return;
    setPurging(true);
    setPurgeMessage('');
    try {
      const result = await api.purgeRuns(purgePreview.days);
      setPurgeMessage(
        `已删除：运行 ${result.result.runs} 轮、逐源 ${result.result.sourceRuns} 条、平台 ${result.result.platformResults} 条、测活 ${result.result.proxyTestRuns} 轮、操作记录 ${result.result.activity} 条。`,
      );
      setPurgePreview(null);
      await reloadHistory();
    } catch (err) {
      setPurgeMessage(err instanceof ApiError ? err.message : '清理失败');
    } finally {
      setPurging(false);
    }
  }

  async function reloadRuns() {
    try {
      const result = await api.workflowRuns();
      setGhRuns(result.runs);
      setLastDispatchedAt(result.lastDispatchedAt ?? null);
    } catch (err) {
      setRunMessage(err instanceof ApiError ? err.message : '读取运行状态失败');
    }
  }

  async function loadMirrors() {
    try {
      const config = await api.mirrors();
      setMirrorTemplates(config.templates);
      setMirrorCustom(config.custom);
    } catch (err) {
      setMirrorMessage(err instanceof ApiError ? err.message : '读取镜像模板失败');
    }
  }

  function updateMirror(id: string, patch: Partial<MirrorTemplate>) {
    setMirrorTemplates((list) => list?.map((item) => (item.id === id ? { ...item, ...patch } : item)) ?? null);
  }

  function addMirror() {
    setMirrorTemplates((list) => [
      ...(list ?? []),
      {
        id: `custom-${Date.now().toString(36)}`,
        name: '新镜像',
        template: 'https://example.com/{url}',
        enabled: true,
      },
    ]);
  }

  function removeMirror(id: string) {
    setMirrorTemplates((list) => list?.filter((item) => item.id !== id) ?? null);
  }

  async function saveMirrorConfig() {
    if (!mirrorTemplates) return;
    setSavingMirrors(true);
    setMirrorMessage('');
    try {
      const config = await api.saveMirrors(mirrorTemplates);
      setMirrorTemplates(config.templates);
      setMirrorCustom(config.custom);
      setMirrorMessage('已保存。下一轮探测会使用新模板。');
    } catch (err) {
      setMirrorMessage(err instanceof ApiError ? err.message : '保存失败');
    } finally {
      setSavingMirrors(false);
    }
  }

  async function resetMirrorConfig() {
    setSavingMirrors(true);
    setMirrorMessage('');
    try {
      const config = await api.resetMirrors();
      setMirrorTemplates(config.templates);
      setMirrorCustom(config.custom);
      setMirrorMessage('已恢复内置 8 条模板。');
    } catch (err) {
      setMirrorMessage(err instanceof ApiError ? err.message : '恢复失败');
    } finally {
      setSavingMirrors(false);
    }
  }

  async function runNow() {
    setDispatching(true);
    setRunMessage('');
    try {
      const result = await api.runProbe({ limit: runLimit.trim(), preferMirror });
      setRunMessage(`已触发（${formatDateTime(result.dispatchedAt)}），约 1–2 分钟后可在这里看到状态。`);
      window.setTimeout(() => void reloadRuns(), 3000);
    } catch (err) {
      setRunMessage(err instanceof ApiError ? err.message : '触发失败');
    } finally {
      setDispatching(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.health(), api.history(30), api.events(200)])
      .then(([healthResult, runsResult, eventsResult]) => {
        if (cancelled) return;
        setHealth(healthResult);
        setRuns(runsResult);
        setEvents(eventsResult);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : '加载失败');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    void reloadRuns();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void loadMirrors();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function changePassword(event: FormEvent) {
    event.preventDefault();
    setMessage('');
    setSaving(true);
    try {
      await api.changePassword(oldPassword, newPassword);
      setOldPassword('');
      setNewPassword('');
      setMessage('密码已更新，下次登录请使用新密码。');
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : '修改失败');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>管理</h1>
          <p className="muted">运行记录、事件与访问密码。修改密码会写入 D1，立即生效。</p>
        </div>
      </div>

      {error && <ErrorBox message={error} />}
      {!health && !error && <Spinner label="正在加载运行信息…" />}

      {health && (
        <div className="stats-grid compact">
          <div className="mini-stat">
            <span className="stat-value">{health.ok ? '正常' : '异常'}</span>
            <span className="stat-label">服务状态</span>
          </div>
          <div className="mini-stat">
            <span className="stat-value">{health.sources}</span>
            <span className="stat-label">音源数</span>
          </div>
          <div className="mini-stat">
            <span className="stat-value">{health.candidates}</span>
            <span className="stat-label">候选数</span>
          </div>
          <div className="mini-stat">
            <span className="stat-value">{health.lastRun ? formatDateTime(health.lastRun.finishedAt) : '—'}</span>
            <span className="stat-label">最近一轮</span>
          </div>
        </div>
      )}

      <section>
        <h2>运行控制</h2>
        <p className="muted">点一下会在 GitHub 上启动一轮探测，不需要再去网站手动点。触发后约 1–2 分钟出结果。</p>
        <div className="run-form">
          <label className="field inline">
            <span>最多测几个源</span>
            <input
              value={runLimit}
              onChange={(event) => setRunLimit(event.target.value)}
              placeholder="留空表示全部"
              inputMode="numeric"
            />
          </label>
          <label className="check">
            <input type="checkbox" checked={preferMirror} onChange={(event) => setPreferMirror(event.target.checked)} />
            <span>优先用镜像下载脚本</span>
          </label>
          <button type="button" className="primary-button" onClick={() => void runNow()} disabled={dispatching}>
            {dispatching ? '触发中…' : '立即运行探测'}
          </button>
          <button type="button" className="ghost-button" onClick={() => void reloadRuns()}>
            刷新状态
          </button>
        </div>
        {runMessage && <div className="form-message">{runMessage}</div>}
        {lastDispatchedAt && <p className="muted">上次网页触发：{formatDateTime(lastDispatchedAt)}</p>}
        {ghRuns.length > 0 && (
          <ul className="run-list">
            {ghRuns.map((run) => (
              <li key={run.id}>
                <span className={`pill run-${run.status}`}>{RUN_STATUS[run.status] ?? run.status}</span>
                <span className="mono muted">{formatDateTime(run.createdAt)}</span>
                <span>{run.event === 'workflow_dispatch' ? '手动触发' : run.event === 'schedule' ? '定时触发' : run.event}</span>
                <span className="muted">{run.conclusion ? (RUN_CONCLUSION[run.conclusion] ?? run.conclusion) : '—'}</span>
                {run.url && (
                  <a href={run.url} target="_blank" rel="noreferrer">
                    查看日志
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>加速镜像</h2>
        <p className="muted">
          探测时会把主地址和这些镜像逐个下载，按文件指纹判断版本。公共镜像会失效，失效后在这里替换即可，下一轮探测自动生效。
          模板里可用 <code>{'{url}'}</code> 表示完整原始地址，或用 <code>{'{owner}/{repo}/{branch}/{path}'}</code> 拼路径。
        </p>
        {!mirrorTemplates ? (
          <Spinner />
        ) : (
          <>
            <div className="mirror-list">
              {mirrorTemplates.map((mirror) => (
                <div className="mirror-row" key={mirror.id}>
                  <input
                    aria-label="镜像名称"
                    value={mirror.name}
                    onChange={(event) => updateMirror(mirror.id, { name: event.target.value })}
                  />
                  <input
                    aria-label="镜像模板"
                    className="mono"
                    value={mirror.template}
                    onChange={(event) => updateMirror(mirror.id, { template: event.target.value })}
                  />
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={mirror.enabled}
                      onChange={(event) => updateMirror(mirror.id, { enabled: event.target.checked })}
                    />
                    <span>启用</span>
                  </label>
                  <button type="button" className="ghost-button danger" onClick={() => removeMirror(mirror.id)}>
                    删除
                  </button>
                </div>
              ))}
            </div>
            <div className="run-form">
              <button type="button" className="ghost-button" onClick={addMirror}>
                添加一条
              </button>
              <button type="button" className="primary-button" onClick={() => void saveMirrorConfig()} disabled={savingMirrors}>
                {savingMirrors ? '保存中…' : '保存模板'}
              </button>
              <button type="button" className="ghost-button" onClick={() => void resetMirrorConfig()} disabled={savingMirrors}>
                恢复默认 8 条
              </button>
              <span className="muted">{mirrorCustom ? '当前使用自定义模板' : '当前使用内置默认模板'}</span>
            </div>
            {mirrorMessage && <div className="form-message">{mirrorMessage}</div>}
          </>
        )}
      </section>

      <section>
        <h2>运行记录</h2>
        {!runs ? (
          <Spinner />
        ) : runs.length === 0 ? (
          <EmptyBox message="暂无运行记录。" />
        ) : (
          <table className="simple-table">
            <thead>
              <tr>
                <th>完成时间</th>
                <th>总源数</th>
                <th>可用 / 部分 / 失效 / 未测</th>
                <th>平台</th>
                <th>耗时</th>
              </tr>
            </thead>
            <tbody>
              {runPager.pageItems.map((run) => (
                <tr key={run.id}>
                  <td>{formatDateTime(run.finishedAt)}</td>
                  <td className="mono">{run.total}</td>
                  <td className="mono">
                    {run.available} / {run.partial} / {run.unavailable} / {run.untested}
                  </td>
                  <td className="mono">
                    {run.platformsOk}/{run.platformsTested}
                  </td>
                  <td className="mono muted">{formatDuration(run.durationMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {runs && runs.length > 0 && <Pagination {...runPager.pagination} label="轮运行" />}
      </section>

      <section>
        <h2>清理运行记录</h2>
        <p className="muted">
          只删除指定天数之前的探测与测活记录；最新一轮探测和最新一轮测活始终保留，避免首页快照失效。先预览，再确认删除。
        </p>
        <div className="run-form">
          <label className="field inline">
            <span>保留最近</span>
            <input
              value={purgeDays}
              onChange={(event) => {
                setPurgeDays(event.target.value);
                setPurgePreview(null);
              }}
              inputMode="numeric"
              aria-label="保留天数"
            />
            <span>天</span>
          </label>
          <button type="button" className="ghost-button" onClick={() => void previewPurge()} disabled={purging}>
            {purging ? '统计中…' : '预览清理'}
          </button>
          <button
            type="button"
            className="primary-button danger"
            onClick={() => void confirmPurge()}
            disabled={!purgePreview || purging}
          >
            确认删除
          </button>
        </div>
        {purgePreview && (
          <div className="notice">
            <div>
              将删除：运行 {purgePreview.runs} 轮、逐源 {purgePreview.sourceRuns} 条、平台{' '}
              {purgePreview.platformResults} 条、任务 {purgePreview.tasks} 条、测活 {purgePreview.proxyTestRuns} 轮/
              {purgePreview.proxyTestResults} 条、操作记录 {purgePreview.activity} 条。
            </div>
            <div className="muted">
              截止 {formatDateTime(purgePreview.cutoff)}；最新探测{' '}
              {purgePreview.latestRunAt ? formatDateTime(purgePreview.latestRunAt) : '无'}；最新测活{' '}
              {purgePreview.latestProxyTestAt ? formatDateTime(purgePreview.latestProxyTestAt) : '无'}。
            </div>
            {purgePreview.clamped && <div className="muted">保留天数早于最新记录，实际只删除最新一轮之前的记录。</div>}
          </div>
        )}
        {purgeMessage && <div className="form-message">{purgeMessage}</div>}
      </section>

      <section>
        <h2>最近事件</h2>
        {!events ? (
          <Spinner />
        ) : events.length === 0 ? (
          <EmptyBox message="暂无事件。" />
        ) : (
          <ul className="event-list">
            {eventPager.pageItems.map((event) => (
              <li key={event.id}>
                <span className={`pill event-${event.type}`}>{EVENT_LABEL[event.type]}</span>
                <span className="mono muted">{formatDateTime(event.at)}</span>
                <span className="event-title">{event.title}</span>
                <span className="muted">{event.message}</span>
              </li>
            ))}
          </ul>
        )}
        {events && events.length > 0 && <Pagination {...eventPager.pagination} label="条事件" />}
      </section>

      <section className="narrow">
        <h2>修改密码</h2>
        <form className="password-form" onSubmit={(event) => void changePassword(event)}>
          <label className="field">
            <span>当前密码</span>
            <input type="password" value={oldPassword} onChange={(event) => setOldPassword(event.target.value)} autoComplete="current-password" />
          </label>
          <label className="field">
            <span>新密码（至少 8 位）</span>
            <input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} autoComplete="new-password" />
          </label>
          <button type="submit" className="primary-button" disabled={saving || !oldPassword || newPassword.length < 8}>
            {saving ? '保存中…' : '保存新密码'}
          </button>
          {message && <div className="form-message">{message}</div>}
        </form>
      </section>
    </div>
  );
}
