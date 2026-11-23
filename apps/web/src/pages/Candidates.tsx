import { useEffect, useMemo, useState } from 'react';
import { formatDateTime, platformMeta, type Candidate } from '@lx/shared';
import { ApiError, api } from '../api';
import { EmptyBox, ErrorBox, Spinner } from '../components/Feedback';

const STATES: { key: string; label: string; tone: string; hint: string }[] = [
  { key: 'new', label: '新发现', tone: 'idle', hint: '尚未通过初始化检测' },
  { key: 'qualified', label: '已通过', tone: 'ok', hint: '初始化成功，可加入清单' },
  { key: 'rejected', label: '已拒绝', tone: 'bad', hint: '确认无用，后续不再提示' },
  { key: 'promoted', label: '已收录', tone: 'warn', hint: '已加入正式清单' },
];

export function CandidatesPage() {
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<string>('all');
  const [busy, setBusy] = useState<string>('');

  async function load() {
    setError('');
    try {
      const result = await api.candidates();
      setCandidates(result.candidates);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '加载候选失败');
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function setState(id: string, state: string) {
    setBusy(id);
    try {
      await api.setCandidateState(id, state);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '更新失败');
    } finally {
      setBusy('');
    }
  }

  const visible = useMemo(() => {
    if (!candidates) return [];
    if (filter === 'all') return candidates;
    return candidates.filter((item) => item.state === filter);
  }, [candidates, filter]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>候选音源</h1>
          <p className="muted">
            自动发现只保存链接，不复制脚本；审核通过后才会进入正式清单。当前共 {candidates?.length ?? 0} 个候选。
          </p>
        </div>
        <div className="page-actions">
          <button type="button" className="ghost-button" onClick={() => void load()}>
            刷新
          </button>
        </div>
      </div>

      <div className="filter-bar">
        <div className="filter-group">
          <span className="filter-label">状态</span>
          <button type="button" className={`filter-chip${filter === 'all' ? ' active' : ''}`} onClick={() => setFilter('all')}>
            全部
          </button>
          {STATES.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`filter-chip${filter === item.key ? ' active' : ''}`}
              onClick={() => setFilter(item.key)}
              title={item.hint}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {error && <ErrorBox message={error} onRetry={() => void load()} />}
      {!candidates && !error && <Spinner label="正在加载候选…" />}
      {candidates && visible.length === 0 && <EmptyBox message="当前筛选下没有候选源。" />}

      {visible.length > 0 && (
        <div className="matrix-wrap">
          <table className="simple-table candidates-table">
            <thead>
              <tr>
                <th>候选</th>
                <th>仓库 / 路径</th>
                <th>声明平台</th>
                <th>初始化</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((candidate) => {
                const state = STATES.find((item) => item.key === candidate.state) ?? STATES[0]!;
                return (
                  <tr key={candidate.id}>
                    <td>
                      <div className="source-title">{candidate.title ?? candidate.id}</div>
                      <div className="source-sub">
                        <span className="mono">{candidate.id}</span>
                        {candidate.version && <span>v{candidate.version}</span>}
                        {candidate.author && <span>{candidate.author}</span>}
                      </div>
                    </td>
                    <td className="mono small">
                      {candidate.repo}
                      <br />
                      {candidate.path}
                    </td>
                    <td>
                      <div className="platform-grid">
                        {(candidate.platforms ?? []).map((key) => (
                          <span key={key} className="platform-chip tone-idle" title={platformMeta(key).name}>
                            <span className="platform-name">{platformMeta(key).short}</span>
                          </span>
                        ))}
                        {(candidate.platforms ?? []).length === 0 && <span className="muted">—</span>}
                      </div>
                    </td>
                    <td>
                      {candidate.initOk === true ? (
                        <span className="pill pill-ok">成功</span>
                      ) : candidate.initOk === false ? (
                        <span className="pill pill-bad" title={candidate.initError ?? ''}>
                          失败
                        </span>
                      ) : (
                        <span className="pill">未测</span>
                      )}
                      {candidate.initError && <div className="source-error">{candidate.initError}</div>}
                    </td>
                    <td>
                      <span className={`status-badge tone-${state.tone}`}>{state.label}</span>
                      <div className="muted small">最近发现 {formatDateTime(candidate.lastSeen ?? candidate.firstSeen ?? '')}</div>
                    </td>
                    <td>
                      <div className="button-row">
                        <button type="button" className="mini-button" disabled={busy === candidate.id} onClick={() => void setState(candidate.id, 'qualified')}>
                          通过
                        </button>
                        <button type="button" className="mini-button" disabled={busy === candidate.id} onClick={() => void setState(candidate.id, 'promoted')}>
                          收录
                        </button>
                        <button type="button" className="mini-button danger" disabled={busy === candidate.id} onClick={() => void setState(candidate.id, 'rejected')}>
                          拒绝
                        </button>
                        {candidate.state !== 'new' && (
                          <button type="button" className="mini-button" disabled={busy === candidate.id} onClick={() => void setState(candidate.id, 'new')}>
                            重置
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
