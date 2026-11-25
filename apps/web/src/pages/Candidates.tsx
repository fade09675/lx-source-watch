import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { formatDateTime, formatRelative, platformMeta, type Candidate } from '@lx/shared';
import { api, type CandidateList } from '../api';
import { EmptyBox, ErrorBox, Spinner } from '../components/Feedback';
import { DiscoveryReposPanel } from '../components/DiscoveryReposPanel';
import { Pagination, useClientPager } from '../components/Pagination';
import { PageHeader, SectionCard, StatCard, StatGrid, Toolbar } from '../components/ui';

const STATE_FALLBACK = { label: '待验证', tone: 'warn', hint: '还没通过初始化' } as const;
const STATE_META: Record<string, { label: string; tone: string; hint: string }> = {
  new: { label: '待验证', tone: 'warn', hint: '还没通过初始化' },
  qualified: { label: '可收录', tone: 'ok', hint: '初始化通过，等自动或手动收录' },
  rejected: { label: '已拒绝', tone: 'bad', hint: '不会自动收录' },
  promoted: { label: '已收录', tone: 'idle', hint: '已进入正式音源清单' },
  duplicate: { label: '重复', tone: 'idle', hint: '与已有音源内容相同，已自动合并为别名' },
};

const STATE_TABS: Array<{ value: string; label: string }> = [
  { value: '', label: '全部' },
  { value: 'new', label: '待验证' },
  { value: 'qualified', label: '可收录' },
  { value: 'promoted', label: '已收录' },
  { value: 'duplicate', label: '重复' },
  { value: 'rejected', label: '已拒绝' },
];

export function CandidatesPage() {
  const [data, setData] = useState<CandidateList | null>(null);
  const [state, setState] = useState('');
  const [query, setQuery] = useState('');
  const [repoFilter, setRepoFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = async (nextState = state, nextQuery = query) => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.candidates(nextState || undefined, nextQuery.trim() || undefined));
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载候选失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(state, query);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const counts = data?.counts ?? {};
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  const repos = Array.from(new Set((data?.candidates ?? []).map((candidate) => candidate.repo))).sort();
  const visibleCandidates = repoFilter
    ? (data?.candidates ?? []).filter((candidate) => candidate.repo === repoFilter)
    : (data?.candidates ?? []);
  const candidatePager = useClientPager(visibleCandidates);
  useEffect(() => {
    candidatePager.reset();
  }, [repoFilter, state, data?.candidates.length, candidatePager.reset]);

  const removeRow = (candidate: Candidate) => {
    setData((current) =>
      current
        ? {
            ...current,
            candidates: current.candidates.filter((item) => item.id !== candidate.id),
            count: Math.max(0, current.count - 1),
          }
        : current,
    );
    void load(state, query);
  };

  const act = async (candidate: Candidate, next: 'promoted' | 'rejected' | 'new') => {
    setBusy(candidate.id);
    setError(null);
    setNotice(null);
    try {
      await api.setCandidateState(candidate.id, next);
      if (next === 'promoted') setNotice(`已收录：${candidate.title ?? candidate.id}，可在音源管理里查看`);
      if (next === 'rejected') setNotice(`已拒绝：${candidate.title ?? candidate.id}`);
      if (next === 'new') setNotice(`已重置：${candidate.title ?? candidate.id}`);
      removeRow(candidate);
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败');
    } finally {
      setBusy(null);
    }
  };

  const runDiscovery = async () => {
    setBusy('discovery');
    try {
      await api.runDiscovery();
      setNotice('已触发一次自动发现，完成后刷新本页查看新候选');
    } catch (err) {
      setError(err instanceof Error ? err.message : '触发失败');
    } finally {
      setBusy(null);
    }
  };

  const promoteAll = async () => {
    setBusy('promote');
    try {
      const result = await api.promoteCandidates();
      setNotice(`自动收录：收录 ${result.promoted.length} 个，跳过 ${result.skipped} 个${result.errors.length ? `，失败 ${result.errors.length} 个` : ''}`);
      void load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '收录失败');
    } finally {
      setBusy(null);
    }
  };

  const clearRejected = async () => {
    if (!window.confirm('删除全部“已拒绝”的候选？')) return;
    setBusy('clear');
    try {
      const result = await api.deleteRejectedCandidates();
      setNotice(`已删除 ${result.deleted} 个已拒绝候选`);
      void load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '清理失败');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="page">
      <PageHeader
        eyebrow="CANDIDATES"
        title="候选源"
        description="从仓库自动发现的脚本先放这里；初始化通过后自动收录，也可以手动收录或拒绝。"
        actions={
          <>
            <button type="button" className="ghost-button" onClick={runDiscovery} disabled={busy === 'discovery'}>
              立即发现
            </button>
            <button type="button" className="ghost-button" onClick={promoteAll} disabled={busy === 'promote'}>
              立即收录
            </button>
          </>
        }
      />

      {notice ? <p className="notice">{notice}</p> : null}
      {error ? <ErrorBox message={error} /> : null}

      <DiscoveryReposPanel />

      <StatGrid compact>
        <StatCard label="全部候选" value={total} hint="最近一次发现的结果" />
        <StatCard label="待验证" value={counts.new ?? 0} hint="尚未通过初始化" tone="warn" />
        <StatCard label="可收录" value={counts.qualified ?? 0} hint="初始化通过、声明了平台" tone="ok" />
        <StatCard
          label="已收录"
          value={counts.promoted ?? 0}
          hint={<Link to="/admin/sources">去音源管理</Link>}
        />
        <StatCard
          label="已拒绝"
          value={counts.rejected ?? 0}
          hint={
            <button type="button" className="link-button" onClick={clearRejected} disabled={busy === 'clear'}>
              清空
            </button>
          }
          tone="bad"
        />
      </StatGrid>

      <SectionCard
        title="候选源"
        description="初始化通过并声明平台后才会进入自动收录范围；重复内容会保留为别名，不重复建源。"
        actions={<span className="muted small">共 {total} 个</span>}
      >
        <Toolbar className="candidate-toolbar">
          <input
            className="search-input candidate-search"
            type="search"
            placeholder="搜索名称、仓库、路径或作者"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void load(state, query);
            }}
          />
          <button type="button" className="ghost-button small" onClick={() => load(state, query)}>
            搜索
          </button>
          <select
            className="search-input candidate-repo"
            value={repoFilter}
            onChange={(event) => setRepoFilter(event.target.value)}
            aria-label="按仓库筛选"
          >
            <option value="">全部仓库</option>
            {repos.map((repo) => (
              <option key={repo} value={repo}>
                {repo}
              </option>
            ))}
          </select>
          <div className="segmented candidate-state-tabs">
            {STATE_TABS.map((tab) => (
              <button
                key={tab.value}
                type="button"
                className={`segmented-item${state === tab.value ? ' active' : ''}`}
                onClick={() => setState(tab.value)}
              >
                {tab.label}
                <span className="segmented-count">{tab.value ? counts[tab.value] ?? 0 : total}</span>
              </button>
            ))}
          </div>
        </Toolbar>

      {loading ? <Spinner label="加载候选" /> : null}

      {!loading && data && visibleCandidates.length === 0 ? (
        <EmptyBox message="没有候选：点「立即发现」从配置的仓库里找新脚本，首次运行可能要等十几秒。" />
      ) : null}

      {!loading && data && visibleCandidates.length > 0 ? (
        <>
          <div className="candidate-list">
            {candidatePager.pageItems.map((candidate) => {
              const meta = STATE_META[candidate.state] ?? STATE_FALLBACK;
              return (
                <article className="candidate-row" key={candidate.id}>
                  <div className="candidate-main">
                    <div className="candidate-title">
                      <strong>{candidate.title ?? candidate.id}</strong>
                      <span className={`pill tone-${meta.tone}`} title={meta.hint}>
                        {meta.label}
                      </span>
                    </div>
                    <div className="candidate-repo" title={`${candidate.repo}/${candidate.path}`}>
                      {candidate.repo}/{candidate.path}
                    </div>
                    <div className="candidate-platforms">
                      {candidate.platforms.length === 0 ? (
                        <span className="muted small">未声明平台</span>
                      ) : (
                        candidate.platforms.map((key) => (
                          <span key={key} className="mini-chip">
                            {platformMeta(key).short}
                          </span>
                        ))
                      )}
                    </div>
                  </div>

                  <div className="candidate-facts">
                    <div>
                      <span>初始化</span>
                      <strong className={candidate.initOk === true ? 'text-ok' : candidate.initOk === false ? 'text-bad' : 'muted'}>
                        {candidate.initOk === true ? '通过' : candidate.initOk === false ? '失败' : '未测'}
                      </strong>
                    </div>
                    <div>
                      <span>版本</span>
                      <strong title={candidate.sha}>{candidate.version ?? '未知'}</strong>
                    </div>
                    <div>
                      <span>首次发现</span>
                      <strong title={formatDateTime(candidate.firstSeen)}>{formatRelative(candidate.firstSeen)}</strong>
                    </div>
                  </div>

                  <div className="candidate-actions">
                    {candidate.state !== 'promoted' ? (
                      <button
                        type="button"
                        className="row-link"
                        disabled={busy === candidate.id}
                        onClick={() => act(candidate, 'promoted')}
                      >
                        收录
                      </button>
                    ) : (
                      <Link className="row-link" to="/admin/sources">
                        查看
                      </Link>
                    )}
                    {candidate.state !== 'rejected' ? (
                      <button
                        type="button"
                        className="row-link danger"
                        disabled={busy === candidate.id}
                        onClick={() => act(candidate, 'rejected')}
                      >
                        拒绝
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="row-link"
                        disabled={busy === candidate.id}
                        onClick={() => act(candidate, 'new')}
                      >
                        重置
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
          <Pagination {...candidatePager.pagination} label="个候选" />
        </>
      ) : null}
      </SectionCard>

      <p className="muted page-foot">
        自动收录要求：初始化通过、至少声明一个平台；每轮数量在上方“设置”里限制。候选 sha 是文件内容指纹，同一地址内容变化会重新进入待验证。
      </p>
    </div>
  );
}
