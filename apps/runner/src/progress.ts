export interface ProbeProgressEvent {
  stage: 'loading' | 'sources' | 'reporting' | 'publishing';
  done: number;
  total: number;
  unit?: string;
  message?: string;
}

export interface ProgressReporter {
  report(event: ProbeProgressEvent): Promise<void>;
}

export interface ProgressOptions {
  url?: string;
  token?: string;
  taskId?: string;
  runId?: string;
}

/**
 * 探测 job 只拿到一次性的 task progress token。
 * 进度上报失败不能影响探测本身，所以这里全部吞掉并只打印警告。
 */
export function createProgressReporter(options: ProgressOptions): ProgressReporter | null {
  const url = options.url?.trim();
  const token = options.token?.trim();
  const taskId = options.taskId?.trim();
  const runId = options.runId?.trim();
  if (!url || !token || !taskId || !runId) return null;

  return {
    async report(event) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...event, taskId, runId, token }),
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) {
          console.warn(`[progress] 上报失败 HTTP ${response.status}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[progress] 上报失败：${message}`);
      }
    },
  };
}
