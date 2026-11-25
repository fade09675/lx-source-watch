import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  STATUS_META,
  formatDateTime,
  formatDuration,
  formatMs,
  platformMeta,
  platformTone,
  type SourceDetailResponse,
} from '@lx/shared';
import { ApiError, api } from '../api';
import { EmptyBox, Spinner } from '../components/Feedback';
import { Icon } from '../components/Icon';
import { StatusBadge } from '../components/StatusBadge';
import { EmptyState, PageHeader, SectionCard } from '../components/ui';
import { hostOf, pickRecommended } from '../lib/endpoints';

type DetailTab = 'overview' | 'platforms' | 'endpoints' | 'history';

export function SourceDetailPage() {
  const { id = '' } = useParams();
  const [data, setData] = useState<SourceDetailResponse | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const [copyTarget, setCopyTarget] = useState('recommended');
  const [tab, setTab] = useState<DetailTab>('overview');

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError('');
    api
      .source(id)
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : '加载失败');
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const endpoints = data?.endpoints ?? [];
  const recommended = pickRecommended(endpoints, data?.source.url ?? '');
  const copyUrl =
    copyTarget === 'recommended'
      ? recommended.url
      : (endpoints.find((item) => item.url === copyTarget)?.url ?? data?.source.url ?? '');

  async function copyLink() {
    if (!copyUrl) return;
    try {
      await navigator.clipboard.writeText(copyUrl);
      setCopied(copyTarget === 'recommended' ? '已复制推荐地址' : '已复制所选地址');
      window.setTimeout(() => setCopied(''), 1800);
    } catch {
      setCopied('');
    }
  }

  if (error) {
    return (
      <div className="page">
        <PageHeader
          eyebrow="SOURCE"
          title="无法打开音源详情"
          description="这个音源可能已被删除、停用，或者地址不正确。"
          actions={
            <Link className="primary-button" to="/sources">
              返回音源总览
            </Link>
          }
        />
        <SectionCard>
          <EmptyState
            icon="alert"
            title="找不到这个音源"
            description={error}
            action={<Link to="/sources">返回音源总览</Link>}
          />
        </SectionCard>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="page">
        <Spinner label="正在加载音源详情…" />
      </div>
    );
  }

  const { source, history, daily, platformDaily } = data;
  const platformKeys = source.platforms.filter((item) => item.declared).map((item) => item.key);
  const cnPlatforms = source.platforms.filter((item) => item.declared && item.cn?.tested);
  const cnOk = cnPlatforms.filter((item) => item.cn?.ok).length;
  const endpointsOk = endpoints.filter((item) => item.ok).length;
  const failedPlatforms = source.platforms.filter((item) => item.declared && item.tested && !item.ok);
  const cnState = cnPlatforms.length > 0 ? `${cnOk}/${cnPlatforms.length}` : failedPlatforms.length > 0 ? '未补测' : '无需补测';
  const origin = source.origin ?? (source.homepage ? hostOf(source.homepage) : '');

  return (
    <div className="page source-detail-page">
      <Link to="/sources" className="back-link">
        <Icon name="chevron-right" size={12} className="back-icon" />
        返回音源总览
      </Link>

      <section className="source-hero">
        <div className="source-hero-main">
          <div className="source-hero-title">
            <h1>{source.title}</h1>
            <StatusBadge status={source.status} />
            {source.version && <span className="pill">v{source.version}</span>}
          </div>
          <div className="source-hero-meta">
            <span className="mono">{source.id}</span>
            {source.author && <span>{source.author}</span>}
            {source.category && <span>{source.category}</span>}
            {source.checkedAt && <span>检测于 {formatDateTime(source.checkedAt)}</span>}
          </div>
          {(origin || source.via) && (
            <div className="source-hero-meta">
              {origin && (
                <span className="source-origin" title={source.origin ?? source.homepage}>
                  来源 {origin}
                </span>
              )}
              {source.via && (
                <span className={`pill tone-${source.via === 'primary' ? 'ok' : 'warn'}`}>
                  本轮{source.via === 'primary' ? '主地址' : '镜像'}
                  {source.chosenUrl ? ` · ${hostOf(source.chosenUrl)}` : ''}
                </span>
              )}
            </div>
          )}
          {source.description && <p className="source-hero-desc">{source.description}</p>}
        </div>
        <div className="source-hero-actions">
          <label className="field compact detail-copy-select">
            <span>导入地址</span>
            <select className="select" value={copyTarget} onChange={(event) => setCopyTarget(event.target.value)}>
              <option value="recommended">推荐：{recommended.kind}</option>
              {endpoints.map((endpoint, index) => (
                <option key={`${endpoint.url}-${index}`} value={endpoint.url}>
                  {endpoint.role === 'primary' ? '主地址' : `镜像（${hostOf(endpoint.url)}）`}
                  {endpoint.ok ? ' · 可用' : ' · 失败'}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="primary-button" onClick={() => void copyLink()}>
            {copied || '复制导入链接'}
          </button>
          {source.homepage && (
            <a className="ghost-button" href={source.homepage} target="_blank" rel="noreferrer">
              <Icon name="external" size={13} />
              脚本主页
            </a>
          )}
        </div>
      </section>

      <div className="detail-stats">
        <MiniStat label="通过平台" value={`${source.stats.ok}/${source.stats.tested}`} />
        <MiniStat label="国内可达" value={cnState} />
        <MiniStat label="接入点" value={`${endpointsOk}/${endpoints.length}`} />
        <MiniStat label="声明平台" value={source.stats.total} />
        <MiniStat label="本轮耗时" value={formatMs(source.durationMs)} />
      </div>

      <nav className="detail-tabs" role="tablist" aria-label="详情视图">
        <TabButton active={tab === 'overview'} onClick={() => setTab('overview')} label="概览" />
        <TabButton
          active={tab === 'platforms'}
          onClick={() => setTab('platforms')}
          label={`平台 ${platformKeys.length}`}
        />
        <TabButton
          active={tab === 'endpoints'}
          onClick={() => setTab('endpoints')}
          label={`接入点 ${endpoints.length}`}
        />
        <TabButton active={tab === 'history'} onClick={() => setTab('history')} label="历史" />
      </nav>

      {tab === 'overview' && (
        <div className="detail-overview">
          {!source.initOk && (
            <div className="error-box">
              <span>初始化失败：{source.initError ?? '未知原因'}</span>
            </div>
          )}
          <div className="detail-pair">
            <section className="panel detail-panel">
              <header className="panel-head">
                <h2>健康摘要</h2>
                <span className="muted small">本轮检测</span>
              </header>
              <dl className="summary-list">
                <div>
                  <dt>声明平台</dt>
                  <dd>{source.stats.total} 个</dd>
                </div>
                <div>
                  <dt>平台通过</dt>
                  <dd>
                    {source.stats.ok}/{source.stats.tested}
                    <span className="muted"> · 失败 {failedPlatforms.length}</span>
                  </dd>
                </div>
                <div>
                  <dt>接入点</dt>
                  <dd>
                    {endpointsOk}/{endpoints.length} 下载成功
                  </dd>
                </div>
                <div>
                  <dt>国内补测</dt>
                  <dd>{cnState}</dd>
                </div>
                <div>
                  <dt>本轮入口</dt>
                  <dd>{source.via ? (source.via === 'primary' ? '主地址' : '镜像') : '—'}</dd>
                </div>
                <div>
                  <dt>耗时</dt>
                  <dd>{formatMs(source.durationMs)}</dd>
                </div>
              </dl>
              {cnPlatforms.length === 0 && (
                <p className="muted small panel-note">
                  {failedPlatforms.length > 0
                    ? '本轮有失败平台，但没有国内补测结果；补测可能未执行，不代表这些平台在国内不可用。'
                    : '海外平台全部通过，本轮无需国内补测；这不代表国内网络一定可用。'}
                </p>
              )}
            </section>

            <section className="panel detail-panel">
              <header className="panel-head">
                <h2>平台状态</h2>
                <span className="muted small">{platformKeys.length} 个已声明</span>
              </header>
              {platformKeys.length === 0 ? (
                <EmptyBox message="该音源没有声明任何平台。" />
              ) : (
                <div className="detail-platform-chips">
                  {source.platforms
                    .filter((item) => item.declared)
                    .map((platform) => (
                      <span
                        key={platform.key}
                        className={`detail-platform-pill tone-${platformTone(platform.tested, platform.ok)}`}
                      >
                        <span style={{ color: platformMeta(platform.key).color }}>{platformMeta(platform.key).short}</span>
                        <strong>{platform.tested ? (platform.ok ? '通过' : '失败') : '未测'}</strong>
                      </span>
                    ))}
                </div>
              )}
              {failedPlatforms.length > 0 && (
                <div className="detail-failures">
                  {failedPlatforms.slice(0, 4).map((platform) => (
                    <div key={platform.key}>
                      <strong>{platformMeta(platform.key).name}</strong>
                      <span>{platform.error ?? platform.errorKind ?? '未知原因'}</span>
                    </div>
                  ))}
                  {failedPlatforms.length > 4 && (
                    <p className="muted small">另有 {failedPlatforms.length - 4} 个失败平台，去「平台」查看。</p>
                  )}
                </div>
              )}
            </section>
          </div>

          {source.endpoints.some((item) => item.versionState === 'lagging') && (
            <div className="notice notice-warn">
              有镜像与主地址内容不一致（版本落后），复制导入链接时默认不会优先选择落后镜像。
            </div>
          )}
        </div>
      )}

      {tab === 'platforms' && (
        <section>
          {platformKeys.length === 0 ? (
            <EmptyBox message="该音源没有声明任何平台。" />
          ) : (
            <div className="platform-cards">
              {source.platforms
                .filter((item) => item.declared)
                .map((platform) => {
                  const meta = platformMeta(platform.key);
                  const tone = platformTone(platform.tested, platform.ok);
                  return (
                    <article key={platform.key} className={`platform-card tone-${tone}`}>
                      <header>
                        <span className="platform-title" style={{ color: meta.color }}>
                          {meta.name}
                        </span>
                        <span className={`platform-state tone-${tone}`}>
                          {platform.tested ? (platform.ok ? '通过' : '失败') : '未测试'}
                        </span>
                      </header>
                      <dl>
                        <div>
                          <dt>音质</dt>
                          <dd>{platform.quality ?? '—'}</dd>
                        </div>
                        <div>
                          <dt>取链 / 首字节 / 总耗时</dt>
                          <dd className="mono">
                            {formatMs(platform.resolveMs)} / {formatMs(platform.ttfbMs)} / {formatMs(platform.totalMs)}
                          </dd>
                        </div>
                        <div>
                          <dt>拉流地址</dt>
                          <dd className="mono small">{platform.urlHost ?? '—'}</dd>
                        </div>
                        {platform.cn && (
                          <div>
                            <dt>国内补测</dt>
                            <dd>
                              {platform.cn.tested
                                ? platform.cn.ok
                                  ? `可达（${formatMs(platform.cn.ms)}）`
                                  : `失败：${platform.cn.error ?? '未知'}`
                                : '未测'}
                            </dd>
                          </div>
                        )}
                      </dl>
                      {platform.error && (
                        <p className="platform-error" title={platform.error}>
                          {platform.error}
                        </p>
                      )}
                    </article>
                  );
                })}
            </div>
          )}
          <p className="muted small">
            取链＝解析播放链接耗时；首字节＝服务器开始返回音频的时间；总耗时＝完整拉流校验；拉流地址是实际播放域名。
          </p>
        </section>
      )}

      {tab === 'endpoints' && (
        <section className="panel">
          <header className="panel-head">
            <h2>接入点</h2>
            <span className="muted small">
              {endpointsOk}/{endpoints.length} 下载成功
            </span>
          </header>
          {endpoints.length === 0 ? (
            <EmptyBox message="这轮没有记录到接入点。" />
          ) : (
            <div className="table-wrap">
              <table className="data-table endpoint-table">
                <thead>
                  <tr>
                    <th>角色</th>
                    <th>地址</th>
                    <th>下载</th>
                    <th>版本</th>
                    <th>耗时</th>
                    <th>国内</th>
                    <th>错误</th>
                  </tr>
                </thead>
                <tbody>
                  {endpoints.map((endpoint) => {
                    const cn = endpoint.cn;
                    return (
                      <tr key={endpoint.url}>
                        <td>
                          <span className={`pill tone-${endpoint.role === 'primary' ? 'ok' : 'idle'}`}>
                            {endpoint.role === 'primary' ? '主地址' : '镜像'}
                          </span>
                        </td>
                        <td>
                          <div className="mono">{hostOf(endpoint.url)}</div>
                          <div className="muted small endpoint-url" title={endpoint.url}>
                            {endpoint.url}
                          </div>
                        </td>
                        <td>
                          <span className={`text-${endpoint.ok ? 'ok' : 'bad'}`}>{endpoint.ok ? '成功' : '失败'}</span>
                          {endpoint.status ? <span className="muted small"> {endpoint.status}</span> : null}
                        </td>
                        <td>
                          {endpoint.versionState === 'synced'
                            ? '同步'
                            : endpoint.versionState === 'lagging'
                              ? '落后'
                              : endpoint.versionState === 'unknown'
                                ? '未知'
                                : '—'}
                          {endpoint.version ? <div className="muted small">v{endpoint.version}</div> : null}
                        </td>
                        <td className="mono">{formatMs(endpoint.ms)}</td>
                        <td>
                          {cn?.tested ? (
                            <span className={cn.ok ? 'text-ok' : 'text-bad'}>
                              {cn.ok ? formatMs(cn.ms) : '不可达'}
                            </span>
                          ) : (
                            <span className="muted">未测</span>
                          )}
                        </td>
                        <td className="muted small endpoint-error" title={endpoint.error ?? cn?.error}>
                          {endpoint.error ?? cn?.error ?? '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {tab === 'history' && (
        <div className="detail-history">
          <section className="panel">
            <header className="panel-head">
              <h2>最近 14 天</h2>
              <span className="muted small">通过率</span>
            </header>
            {daily.length === 0 ? (
              <EmptyBox message="还没有历史数据，等下一轮检测后再来。" />
            ) : (
              <div className="bar-chart detail-bar-chart">
                {daily.map((row) => {
                  const ratio = row.testedSum > 0 ? row.okSum / row.testedSum : 0;
                  const height = Math.max(4, Math.round(ratio * 100));
                  return (
                    <div
                      key={row.day}
                      className="bar-column"
                      title={`${row.day}：${row.okSum}/${row.testedSum}（${row.runs} 轮，平均 ${formatMs(row.avgMs)}）`}
                    >
                      <div className="bar-track">
                        <div
                          className={`bar-fill tone-${STATUS_META[row.status].tone}`}
                          style={{ height: `${height}%` }}
                        />
                      </div>
                      <span className="bar-label">{row.day.slice(5)}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section className="panel">
            <header className="panel-head">
              <h2>平台趋势</h2>
              <span className="muted small">按天聚合</span>
            </header>
            {platformDaily.length === 0 ? (
              <EmptyBox message="暂无按平台聚合的数据。" />
            ) : (
              <div className="sparkline-card">
                {platformDaily.map((row) => {
                  const ratio = row.testedCount > 0 ? row.okCount / row.testedCount : 0;
                  return (
                    <div key={row.day} className="spark-row">
                      <span className="mono">{row.day}</span>
                      <div className="spark-track">
                        <div className="spark-fill" style={{ width: `${Math.round(ratio * 100)}%` }} />
                      </div>
                      <span className="mono muted">
                        {row.okCount}/{row.testedCount} · {formatMs(row.avgMs)}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section className="panel">
            <header className="panel-head">
              <h2>最近轮次</h2>
              <span className="muted small">{history.length} 轮</span>
            </header>
            {history.length === 0 ? (
              <EmptyBox message="暂无轮次记录。" />
            ) : (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>时间</th>
                      <th>状态</th>
                      <th>通过 / 已测</th>
                      <th>耗时</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((run) => (
                      <tr key={run.runId}>
                        <td>{formatDateTime(run.finishedAt)}</td>
                        <td>
                          <StatusBadge status={run.status} dense />
                        </td>
                        <td className="mono">
                          {run.ok}/{run.tested} / {run.total}
                        </td>
                        <td className="mono muted">{formatDuration(run.durationMs)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button type="button" role="tab" aria-selected={active} className={active ? 'active' : ''} onClick={onClick}>
      {label}
    </button>
  );
}

function MiniStat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="mini-stat">
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}
