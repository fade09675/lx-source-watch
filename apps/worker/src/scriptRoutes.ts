import { Hono } from 'hono';
import type { Env } from './env';
import { readScript } from './sourceFiles';

const SCRIPT_FILE = /^([a-f0-9]{64})\.js$/i;

/**
 * 公开的哈希脚本地址：内容寻址，路径不含来源标题/作者/后台 ID，
 * 可直接作为播放器的自定义源地址。
 */
export function createScriptRoutes() {
  const app = new Hono<{ Bindings: Env }>();

  app.get('/:file', async (c) => {
    const match = SCRIPT_FILE.exec(c.req.param('file'));
    if (!match) return c.text('not found', 404);
    const code = await readScript(c.env, match[1]!);
    if (code === null) return c.text('script not found', 404);
    return new Response(code, {
      headers: {
        'content-type': 'application/javascript; charset=utf-8',
        'cache-control': 'public, max-age=31536000, immutable',
        'access-control-allow-origin': '*',
        'x-content-type-options': 'nosniff',
        'content-disposition': `inline; filename="${match[1]!.toLowerCase()}.js"`,
      },
    });
  });

  return app;
}
