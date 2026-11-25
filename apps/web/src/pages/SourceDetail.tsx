import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  STATUS_META,
  formatDateTime,
  formatDuration,
  formatMs,
  platformMeta,
  platformTone,
  type EndpointRow,
  type SourceDetailResponse,
} from '@lx/shared';
import { ApiError, api } from '../api';
import { EmptyBox, ErrorBox, Spinner } from '../components/Feedback';
import { StatusBadge } from '../components/StatusBadge';

export function SourceDetailPage() {
  const { id = '' } = useParams();
  const [data, setData] = useState<SourceDetailResponse | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const [copyTarget, setCopyTarget] = useState('recommended');

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
  const copyUrl = copyTarget === 'recommended' ? recommended.url : (endpoints.find((item) => item.url === copyTarget)?.url ?? data?.source.url ?? '');

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

  if (error) return <ErrorBox message={error} />;
  if (!data) return <Spinner label="正在加载音源详情…" />;

  const { source, history, daily, platformDaily } = data;
  const platformKeys = source.platforms.filter((item) => item.declared).map((item) => item.key);
  const cnPlatforms = source.platforms.filter((item) => item.declared && item.cn?.tested);
  const cnOk = cnPlatforms.filter((item) => item.cn?.ok).length;

  return (
    <div className="page">
      <div className="detail-head">
        <div>
          <Link to="/sources" className="back-link">
            ← 返回总览
          </Link>
          <h1>{source.title}</h1>
          <p className="muted">
            <span className="mono">{source.id}</span>
            {source.version && ` · v${source.version}`}
            {source.author && ` · ${source.author}`}
            {source.category && ` · ${source.category}`}
          </p>
          {(source.origin || source.homepage || source.via) && (
            <p className="muted small">
              {source.origin ? `来源：${source.origin}` : source.homepage ? `来源：${hostOf(source.homepage)}` : ''}
              {source.via ? ` · 本轮通过${source.via === 'primary' ? '主地址' : '镜像'}加载${source.chosenUrl ? `（${hostOf(source.chosenUrl)}）` : ''}` : ''}
            </p>
          )}
          {source.description && <p className="description">{source.description}</p>}
        </div>
        <div className="detail-actions">
          <StatusBadge status={source.status} />
          <label className="field compact">
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
              脚本主页
            </a>
          )}
        </div>
      </div>

      <div className="stats-grid compact">
        <MiniStat label="通过平台" value={`${source.stats.ok}/${source.stats.tested}`} />
        <MiniStat label="国内可达" value={cnPlatforms.length > 0 ? `${cnOk}/${cnPlatforms.length}` : '未测'} />
        <MiniStat label="声明平台" value={source.stats.total} />
        <MiniStat label="本轮耗时" value={formatMs(source.durationMs)} />
        <MiniStat label="检测时间" value={formatDateTime(source.checkedAt)} />
      </div>
      {cnPlatforms.length === 0 && (
        <p className="muted small">国内补测只覆盖海外失败的播放地址；这里显示“未测”表示本轮没有需要补测的平台，不代表国内不可用。</p>
      )}

      {!source.initOk && (
        <div className="error-box">
          <span>初始化失败：{source.initError ?? '未知原因'}</span>
        </div>
      )}

      <section>
        <h2>平台明细</h2>
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
                            {platform.cn.tested ? (platform.cn.ok ? `可达（${formatMs(platform.cn.ms)}）` : `失败：${platform.cn.error ?? '未知'}`) : '未测'}
                          </dd>
                        </div>
                      )}
                    </dl>
                    {platform.error && <p className="platform-error">{platform.error}</p>}
                  </article>
                );
              })}
          </div>
        )}
        <p className="muted small">
          取链＝解析播放链接耗时；首字节＝服务器开始返回音频的时间；总耗时＝完整拉流校验；拉流地址是实际播放域名。
        </p>
      </section>

      <section>
        <h2>最近 14 天</h2>
        {daily.length === 0 ? (
          <EmptyBox message="还没有历史数据，等下一轮检测后再来。" />
        ) : (
          <div className="chart-card">
            <div className="bar-chart">
              {daily.map((row) => {
                const ratio = row.testedSum > 0 ? row.okSum / row.testedSum : 0;
                const height = Math.max(4, Math.round(ratio * 100));
                return (
                  <div key={row.day} className="bar-column" title={`${row.day}：${row.okSum}/${row.testedSum}（${row.runs} 轮，平均 ${formatMs(row.avgMs)}）`}>
                    <div className="bar-track">
                      <div className={`bar-fill tone-${STATUS_META[row.status].tone}`} style={{ height: `${height}%` }} />
                    </div>
                    <span className="bar-label">{row.day.slice(5)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </section>

      <section>
        <h2>平台上手率</h2>
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

      <section>
        <h2>最近轮次</h2>
        {history.length === 0 ? (
          <EmptyBox message="暂无轮次记录。" />
        ) : (
          <table className="simple-table">
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
        )}
      </section>
    </div>
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

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function pickRecommended(endpoints: EndpointRow[], fallback: string): { url: string; kind: string } {
  const primary = endpoints.find((item) => item.role === 'primary');
  const mirrors = endpoints.filter((item) => item.role === 'candidate');
  const candidates = [primary, ...mirrors].filter((item): item is EndpointRow => Boolean(item?.ok));
  const score = (item: EndpointRow): number => {
    const synced = item.versionState === 'synced';
    if (item.role === 'primary') return synced ? 0 : 3;
    return synced ? 1 : 2;
  };
  candidates.sort((a, b) => {
    const byScore = score(a) - score(b);
    if (byScore !== 0) return byScore;
    return (a.ms ?? Number.POSITIVE_INFINITY) - (b.ms ?? Number.POSITIVE_INFINITY);
  });
  const best = candidates[0];
  if (best) {
    return {
      url: best.url,
      kind: best.role === 'primary' ? (best.versionState === 'synced' ? '主地址' : '主地址（版本落后）') : `镜像 ${hostOf(best.url)}`,
    };
  }
  if (primary) return { url: primary.url, kind: '主地址（当前不可用）' };
  return { url: fallback, kind: '源地址' };
}
