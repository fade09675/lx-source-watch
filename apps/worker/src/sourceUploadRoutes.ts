import { Hono } from 'hono';
import type { Env } from './env';
import { createSourceRegistry, getSourceRegistry } from './sourceRegistry';
import {
  deleteSourceFile,
  downloadFilename,
  getSourceFile,
  readScript,
  recordSourceFile,
  sanitizeSourceFilename,
  scriptUrl,
  sha256Hex,
  storeScript,
  validateUpload,
  type UploadSourceBody,
} from './sourceFiles';
import { createTask, dispatchNext } from './tasks';

function attachmentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export function createSourceUploadRoutes() {
  const app = new Hono<{ Bindings: Env }>();

  app.post('/upload', async (c) => {
    let body: UploadSourceBody;
    try {
      body = (await c.req.json()) as UploadSourceBody;
    } catch {
      return c.json({ error: 'invalid_json', message: '请求体不是 JSON' }, 400);
    }

    const checked = validateUpload(body);
    if (!checked.ok) {
      return c.json({ error: 'invalid_script', message: checked.message }, 400);
    }
    const upload = checked.value;
    const sha256 = await sha256Hex(upload.content);

    const duplicate = await c.env.DB.prepare(
      'SELECT id, title FROM source_registry WHERE content_sha256 = ? LIMIT 1',
    )
      .bind(sha256)
      .first<{ id: string; title: string }>();
    if (duplicate) {
      return c.json(
        {
          error: 'duplicate_script',
          message: `脚本内容已存在：${duplicate.title}`,
          sourceId: duplicate.id,
        },
        409,
      );
    }

    await storeScript(c.env, sha256, upload.content);
    const origin = c.env.PUBLIC_ORIGIN || new URL(c.req.url).origin;
    const url = scriptUrl(origin, sha256);
    const created = await createSourceRegistry(c.env.DB, {
      title: upload.title,
      author: upload.author,
      category: upload.category,
      url,
      homepage: upload.homepage,
      origin: 'upload',
      contentSha256: sha256,
      enabled: true,
      trusted: true,
      notes: upload.notes || `上传脚本 ${upload.filename}`,
    });
    if (!created.ok) {
      return c.json({ error: 'invalid_source', message: created.errors.join('；') }, 400);
    }

    await recordSourceFile(c.env, created.row.id, sha256, sanitizeSourceFilename(upload.filename), upload.bytes);

    let testTaskId: string | null = null;
    let testStatus: string | null = null;
    let testDispatchMessage: string | null = null;
    if (upload.testAfterSave) {
      const task = await createTask(c.env.DB, {
        type: 'source-test',
        source: 'manual',
        payload: { sourceId: created.row.id, preferMirror: true },
        priority: 2,
      });
      testTaskId = task.id;
      testStatus = task.status;
      const dispatched = await dispatchNext(c.env);
      testDispatchMessage = dispatched.message;
    }

    return c.json(
      {
        ok: true,
        source: created.row,
        file: {
          sha256,
          bytes: upload.bytes,
          filename: sanitizeSourceFilename(upload.filename),
          url,
        },
        testTaskId,
        testStatus,
        testDispatchMessage,
      },
      201,
    );
  });

  app.get('/:id/script', async (c) => {
    const id = c.req.param('id');
    const source = await getSourceRegistry(c.env.DB, id);
    if (!source) return c.json({ error: 'not_found', message: '音源不存在' }, 404);
    const file = await getSourceFile(c.env, id);
    if (!file) return c.json({ error: 'not_uploaded', message: '这个音源不是上传型，不能下载脚本' }, 404);
    const code = await readScript(c.env, file.sha256);
    if (code === null) return c.json({ error: 'script_missing', message: '脚本内容不存在或已过期' }, 404);
    return new Response(code, {
      headers: {
        'content-type': 'application/javascript; charset=utf-8',
        'content-disposition': attachmentDisposition(downloadFilename(source.title || file.filename)),
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  });

  app.delete('/:id/script', async (c) => {
    const id = c.req.param('id');
    const source = await getSourceRegistry(c.env.DB, id);
    if (!source) return c.json({ error: 'not_found', message: '音源不存在' }, 404);
    await deleteSourceFile(c.env, id);
    return c.json({ ok: true });
  });

  return app;
}
