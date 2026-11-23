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
import { EmptyBox, ErrorBox, Spinner } from '../components/Feedback';
import { StatusBadge } from '../components/StatusBadge';

export function SourceDetailPage() {
  const { id = '' } = useParams();
  const [data, setData] = useState<SourceDetailResponse | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

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

  async function copyUrl() {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(data.source.url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  if (error) return <ErrorBox message={error} />;
  if (!data) return <Spinner label="正在加载音源详情…" />;

  const { source, history, daily, platformDaily } = data;
  const platformKeys = source.platforms.filter((item) => item.declared).map((item) => item.key);

  return (
    <div className="page">
      <div className="detail-head">
        <div>
          <Link to="/" className="back-link">
            ← 返回总览
          </Link>
          <h1>{source.title}</h1>
          <p className="muted">
            <span className="mono">{source.id}</span>
            {source.version && ` · v${source.version}`}
            {source.author && ` · ${source.author}`}
            {source.category && ` · ${source.category}`}
          </p>
          {source.description && <p className="description">{source.description}</p>}
        </div>
        <div className="detail-actions">
          <StatusBadge status={source.status} />
          <button type="button" className="primary-button" onClick={() => void copyUrl()}>
            {copied ? '已复制' : '复制导入链接'}
          </button>
          {source.homepage && (
            <a className="ghost-button" href={source.homepage} target="_blank" rel="noreferrer">
              项目主页
            </a>
          )}
        </div>
      </div>

      <div className="stats-grid compact">
        <MiniStat label="通过平台" value={`${source.stats.ok}/${source.stats.tested}`} />
        <MiniStat label="声明平台" value={source.stats.total} />
        <MiniStat label="本轮耗时" value={formatMs(source.durationMs)} />
        <MiniStat label="检测时间" value={formatDateTime(source.checkedAt)} />
      </div>

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
