export type RunLogLine = {
  at?: string;
  level: 'info' | 'step' | 'success' | 'warn' | 'error';
  message: string;
};

const ANSI = /\u001b\[[0-9;]*m/g;
const ISO_TIME = /^\s*\[(\d{4}-\d{2}-\d{2}T[^\]]+)\]\s*(.*)$/;
const TIME = /^\s*(\d{2}:\d{2}:\d{2})\s+(.*)$/;
const MARKER = /^\s*(?:[!⚠✓✔✗×▶]\s*)+/;

function levelOf(text: string): RunLogLine['level'] {
  if (/^\s*(?:!|⚠)\s/.test(text)) return 'warn';
  if (/^\s*(?:✗|×|error|ERROR|失败|错误)\b/i.test(text)) return 'error';
  if (/^\s*(?:✓|✔|成功)/.test(text)) return 'success';
  if (/^\s*▶/.test(text)) return 'step';
  return 'info';
}

/** 把 runner 的纯文本运行日志转换为一行一个 JSON 的结构化日志。 */
export function textToJsonl(text: string): string {
  const lines = text.replace(ANSI, '').split(/\r?\n/);
  const out: string[] = [];
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const match = ISO_TIME.exec(raw) ?? TIME.exec(raw);
    const at = match?.[1];
    const rawBody = (match?.[2] ?? raw).trim();
    const body = rawBody.replace(MARKER, '').trim();
    out.push(
      JSON.stringify({
        ...(at ? { at } : {}),
        level: levelOf(rawBody),
        message: body,
      } satisfies RunLogLine),
    );
  }
  return out.join('\n');
}

export function parseJsonl(text: string): RunLogLine[] {
  const out: RunLogLine[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Partial<RunLogLine>;
      if (typeof parsed.message !== 'string') continue;
      out.push({
        at: typeof parsed.at === 'string' ? parsed.at : undefined,
        level: parsed.level === 'step' || parsed.level === 'success' || parsed.level === 'warn' || parsed.level === 'error'
          ? parsed.level
          : 'info',
        message: parsed.message,
      });
    } catch {
      out.push({ level: 'info', message: line });
    }
  }
  return out;
}
