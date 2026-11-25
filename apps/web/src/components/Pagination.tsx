import { useCallback, useMemo, useState } from 'react';

export interface PaginationProps {
  total: number;
  limit: number;
  offset: number;
  onChange: (next: { limit: number; offset: number }) => void;
  pageSizes?: number[];
  label?: string;
}

const DEFAULT_SIZES = [10, 20, 50, 0];

/** 客户端分页：适用于已经整批取回的列表。 */
export function useClientPager<T>(items: T[], initialLimit = 10) {
  const [limit, setLimit] = useState(initialLimit);
  const [offset, setOffset] = useState(0);
  const total = items.length;
  const effective = limit > 0 ? limit : Math.max(1, total);
  const lastOffset = Math.max(0, Math.ceil(total / effective) - 1) * effective;
  const safeOffset = Math.min(offset, lastOffset);
  const pageItems = useMemo(
    () => items.slice(safeOffset, limit > 0 ? safeOffset + limit : total),
    [items, safeOffset, limit, total],
  );
  const onChange = useCallback((next: { limit: number; offset: number }) => {
    setLimit(next.limit);
    setOffset(next.offset);
  }, []);
  const reset = useCallback(() => setOffset(0), []);
  return {
    pageItems,
    pagination: { total, limit, offset: safeOffset, onChange },
    reset,
  };
}

function sizeLabel(size: number): string {
  return size === 0 ? '全部' : String(size);
}

/** 通用分页：0 表示“全部”（由调用方换算成上限）。 */
export function Pagination({
  total,
  limit,
  offset,
  onChange,
  pageSizes = DEFAULT_SIZES,
  label = '条',
}: PaginationProps) {
  const effectiveLimit = limit > 0 ? limit : Math.max(1, total);
  const pages = Math.max(1, Math.ceil(total / effectiveLimit));
  const page = Math.min(pages, Math.floor(offset / effectiveLimit) + 1);
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(total, offset + effectiveLimit);

  const sizes = useMemo(() => (pageSizes.includes(0) ? pageSizes : [...pageSizes, 0]), [pageSizes]);

  function go(nextPage: number) {
    const target = Math.max(1, Math.min(pages, nextPage));
    onChange({ limit, offset: (target - 1) * effectiveLimit });
  }

  return (
    <div className="pagination">
      <span className="muted small">
        共 {total.toLocaleString('zh-CN')} {label}，当前 {from}–{to}
      </span>
      <div className="pagination-actions">
        <button type="button" className="ghost-button small" onClick={() => go(1)} disabled={page <= 1}>
          首页
        </button>
        <button type="button" className="ghost-button small" onClick={() => go(page - 1)} disabled={page <= 1}>
          上一页
        </button>
        <span className="mono small">
          {page} / {pages}
        </span>
        <button type="button" className="ghost-button small" onClick={() => go(page + 1)} disabled={page >= pages}>
          下一页
        </button>
        <button type="button" className="ghost-button small" onClick={() => go(pages)} disabled={page >= pages}>
          末页
        </button>
        <select
          className="select small"
          value={limit}
          onChange={(event) => onChange({ limit: Number(event.target.value), offset: 0 })}
          aria-label="每页条数"
        >
          {sizes.map((size) => (
            <option key={size} value={size}>
              每页 {sizeLabel(size)}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
