import { useEffect, useMemo, useState } from 'react';
import { parseJsonl, type RunLogLine } from '@lx/shared';
import { ApiError, api } from '../api';
import { ErrorBox, Spinner } from './Feedback';
import { Pagination, useClientPager } from './Pagination';

const LEVEL_LABEL: Record<RunLogLine['level'], string> = {
  info: '信息',
  step: '阶段',
  success: '成功',
  warn: '警告',
  error: '错误',
};

interface RunStructuredLogProps {
  runId: string;
  query?: string;
}

export function RunStructuredLog({ runId, query = '' }: RunStructuredLogProps) {
  const [lines, setLines] = useState<RunLogLine[]>([]);
  const [bytes, setBytes] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    api
      .runLogJsonl(runId)
      .then((result) => {
        if (cancelled) return;
        setLines(parseJsonl(result.jsonl));
        setBytes(result.bytes);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : '加载结构化日志失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [runId]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return lines
      .map((line, index) => ({ ...line, number: index + 1 }))
      .filter((line) => !needle || line.message.toLowerCase().includes(needle));
  }, [lines, query]);

  const pager = useClientPager(visible, 200);
  const reset = pager.reset;
  useEffect(() => {
    reset();
  }, [query, lines, reset]);

  if (loading) return <Spinner label="正在加载结构化日志…" />;
  if (error) return <ErrorBox message={error} />;
  if (!lines.length) return <p className="muted">本轮没有结构化日志。</p>;

  return (
    <div className="table-wrap">
      <table className="data-table compact-table structured-log-table">
        <thead>
          <tr>
            <th>#</th>
            <th>时间</th>
            <th>级别</th>
            <th>消息</th>
          </tr>
        </thead>
        <tbody>
          {pager.pageItems.map((line) => (
            <tr key={line.number}>
              <td className="muted small mono">{line.number}</td>
              <td className="muted small mono">{line.at ?? '—'}</td>
              <td>
                <span className={`log-level log-level-${line.level}`}>{LEVEL_LABEL[line.level]}</span>
              </td>
              <td className="mono small">{line.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="panel-head structured-log-foot">
        <span className="muted small">
          {visible.length}/{lines.length} 条 · {(bytes / 1024).toFixed(1)} KB
        </span>
        <Pagination {...pager.pagination} pageSizes={[200, 500, 1000, 0]} label="条" />
      </div>
    </div>
  );
}
