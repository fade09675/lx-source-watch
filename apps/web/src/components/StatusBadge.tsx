import { STATUS_META, type SourceStatus } from '@lx/shared';

export function StatusBadge({ status, dense = false }: { status: SourceStatus; dense?: boolean }) {
  const meta = STATUS_META[status];
  return (
    <span className={`status-badge tone-${meta.tone}${dense ? ' dense' : ''}`} title={meta.label}>
      <span className="dot" style={{ background: meta.color }} />
      {dense ? meta.short : meta.label}
    </span>
  );
}
