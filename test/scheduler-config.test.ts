import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('worker scheduled config', () => {
  it('wrangler.jsonc 配置了每 5 分钟的 Cron Trigger', () => {
    const config = JSON.parse(readFileSync('apps/worker/wrangler.jsonc', 'utf8')) as {
      triggers?: { crons?: string[] };
    };
    expect(config.triggers?.crons).toContain('*/5 * * * *');
  });

  it('Worker 导出 scheduled 处理器', () => {
    const source = readFileSync('apps/worker/src/index.ts', 'utf8');
    expect(source).toContain('scheduled(');
    expect(source).toContain('runScheduler');
    expect(source).toContain('satisfies ExportedHandler<Env>');
  });
});
