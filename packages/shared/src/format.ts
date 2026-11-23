const MS = (n: number) => Math.round(n);

export function formatMs(ms: number | undefined | null): string {
  if (ms === undefined || ms === null || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${MS(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export function formatDuration(ms: number | undefined): string {
  if (!ms || ms < 0) return '—';
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} 秒`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return `${min} 分 ${sec} 秒`;
}

/** 只保留 host + 路径前 48 字符，去掉 query，避免泄露签名参数。 */
export function safeUrlHost(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    const path = u.pathname.length > 48 ? `${u.pathname.slice(0, 48)}…` : u.pathname;
    return `${u.hostname}${path === '/' ? '' : path}`;
  } catch {
    return undefined;
  }
}

export function truncate(text: string | undefined | null, max = 240): string | undefined {
  if (!text) return undefined;
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

const DATE_TIME = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const DATE_ONLY = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function formatDateTime(iso: string | undefined | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return DATE_TIME.format(d).replace(/\//g, '-');
}

export function formatDate(iso: string | undefined | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return DATE_ONLY.format(d).replace(/\//g, '-');
}

export function formatRelative(iso: string | undefined | null, now = Date.now()): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const diff = Math.max(0, now - t);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day} 天前`;
  return formatDate(iso);
}

export function nextCheckAt(generatedAt: string, intervalHours: number): string {
  return new Date(new Date(generatedAt).getTime() + intervalHours * 3600_000).toISOString();
}

export function toDay(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}
