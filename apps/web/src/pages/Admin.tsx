import { useEffect, useState, type FormEvent } from 'react';
import { formatDateTime, formatDuration, type EventItem, type HealthResponse, type RunSummary } from '@lx/shared';
import { ApiError, api } from '../api';
import { EmptyBox, ErrorBox, Spinner } from '../components/Feedback';

const EVENT_LABEL: Record<EventItem['type'], string> = {
  recovered: '恢复',
  degraded: '降级',
  failed: '持续失效',
  new: '新源',
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

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.health(), api.history(14), api.events(50)])
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
              {runs.map((run) => (
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
      </section>

      <section>
        <h2>最近事件</h2>
        {!events ? (
          <Spinner />
        ) : events.length === 0 ? (
          <EmptyBox message="暂无事件。" />
        ) : (
          <ul className="event-list">
            {events.map((event) => (
              <li key={event.id}>
                <span className={`pill event-${event.type}`}>{EVENT_LABEL[event.type]}</span>
                <span className="mono muted">{formatDateTime(event.at)}</span>
                <span className="event-title">{event.title}</span>
                <span className="muted">{event.message}</span>
              </li>
            ))}
          </ul>
        )}
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
