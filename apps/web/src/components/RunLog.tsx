import { useEffect, useMemo, useState } from 'react';
import { ApiError, api } from '../api';
import { ErrorBox, Spinner } from './Feedback';
import { Pagination, useClientPager } from './Pagination';

const ANSI = /\u001b\[[0-9;]*m/g;
const ERROR_LINE = /error|fail|exception|timeout|refused|reset|unreachable|失败|异常|超时|错误/i;

function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

interface RunLogProps {
  runId: string;
  query?: string;
  onQueryChange?: (value: string) => void;
}

export function RunLog({ runId, query: externalQuery, onQueryChange }: RunLogProps) {
  const [log, setLog] = useState('');
  const [available, setAvailable] = useState(false);
  const [bytes, setBytes] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [internalQuery, setInternalQuery] = useState('');
  const [onlyErrors, setOnlyErrors] = useState(false);
  const [copied, setCopied] = useState(false);

  const query = externalQuery ?? internalQuery;
  const updateQuery = (value: string) => {
    if (onQueryChange) onQueryChange(value);
    else setInternalQuery(value);
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    api
      .runLog(runId)
      .then((result) => {
        if (cancelled) return;
        setLog(stripAnsi(result.log));
        setAvailable(result.available);
        setBytes(result.bytes);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : '加载运行日志失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [runId]);

  const lines = useMemo(() => {
    const all = log.split(/\r?\n/);
    if (all.length > 1 && all[all.length - 1] === '') all.pop();
    return all;
  }, [log]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return lines
      .map((text, index) => ({ text, number: index + 1 }))
      .filter((line) => {
        if (onlyErrors && !ERROR_LINE.test(line.text)) return false;
        if (needle && !line.text.toLowerCase().includes(needle)) return false;
        return true;
      });
  }, [lines, onlyErrors, query]);

  const errorCount = useMemo(() => lines.filter((line) => ERROR_LINE.test(line)).length, [lines]);
  const visiblePager = useClientPager(visible, 200);
  const resetVisiblePager = visiblePager.reset;

  useEffect(() => {
    resetVisiblePager();
  }, [query, onlyErrors, log, resetVisiblePager]);

  async function copyLog() {
    try {
      await navigator.clipboard.writeText(log);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  function downloadLog() {
    const blob = new Blob([log], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${runId}.log`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section id="run-log">
      <div className="panel-head">
        <h2>运行日志</h2>
        <span className="muted small">
          {available ? `${lines.length} 行 · ${(bytes / 1024).toFixed(1)} KB` : '未上传'}
          {errorCount > 0 ? ` · ${errorCount} 行可疑` : ''}
        </span>
      </div>

      {loading ? (
        <Spinner label="正在加载运行日志…" />
      ) : error ? (
        <ErrorBox message={error} />
      ) : !available ? (
        <p className="muted">本轮没有上传日志（旧版本运行或上报时未带日志）。</p>
      ) : (
        <div className="panel log-panel">
          <div className="log-toolbar">
            <input
              className="log-search"
              placeholder="搜索日志（源、平台、地址、错误）"
              value={query}
              onChange={(event) => updateQuery(event.target.value)}
            />
            <label className="check">
              <input type="checkbox" checked={onlyErrors} onChange={(event) => setOnlyErrors(event.target.checked)} />
              只看可疑行
            </label>
            <span className="muted small">
              {visible.length}/{lines.length} 行
            </span>
            <button type="button" className="ghost-button" onClick={copyLog}>
              {copied ? '已复制' : '复制'}
            </button>
            <button type="button" className="ghost-button" onClick={downloadLog}>
              下载
            </button>
          </div>
          {visible.length === 0 ? (
            <p className="muted log-empty">没有匹配的日志行。</p>
          ) : (
            <>
              <pre className="log-view">
                {visiblePager.pageItems.map((line) => (
                  <span
                    className={ERROR_LINE.test(line.text) ? 'log-line is-error' : 'log-line'}
                    key={line.number}
                  >
                    <span className="log-ln">{line.number}</span>
                    {line.text || ' '}
                    {'\n'}
                  </span>
                ))}
              </pre>
              <Pagination
                {...visiblePager.pagination}
                pageSizes={[200, 500, 1000, 0]}
                label="行"
              />
            </>
          )}
        </div>
      )}
    </section>
  );
}
