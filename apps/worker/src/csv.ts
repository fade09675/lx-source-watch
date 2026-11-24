import type { ExportItem } from '@lx/shared';

// CSV 只在必要时加引号：含逗号、双引号、换行，或首尾空白。
export function csvCell(value: unknown): string {
  const text = value === undefined || value === null ? '' : String(value);
  if (text === '') return '';
  const needsQuotes = /[",\r\n]/.test(text) || /^\s|\s$/.test(text);
  return needsQuotes ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(items: ExportItem[]): string {
  const header = ['id', 'title', 'url', 'mirror', 'homepage', 'status', 'ok', 'tested', 'total', 'platforms'];
  const lines = [header.join(',')];
  for (const item of items) {
    const platforms = item.platforms
      .map((platform) => `${platform.key}:${platform.tested ? (platform.ok ? 'ok' : 'fail') : 'untested'}`)
      .join('|');
    lines.push(
      [
        item.id,
        item.title,
        item.url,
        item.mirror ?? '',
        item.homepage ?? '',
        item.status,
        item.ok,
        item.tested,
        item.total,
        platforms,
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}
