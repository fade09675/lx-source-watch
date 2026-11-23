export function Spinner({ label = '加载中…' }: { label?: string }) {
  return (
    <div className="loading-row">
      <span className="spinner" />
      {label}
    </div>
  );
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="error-box">
      <span>{message}</span>
      {onRetry && (
        <button type="button" className="ghost-button" onClick={onRetry}>
          重试
        </button>
      )}
    </div>
  );
}

export function EmptyBox({ message }: { message: string }) {
  return <div className="empty-box">{message}</div>;
}
