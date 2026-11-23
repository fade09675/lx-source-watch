import { SnapshotSchema, type ExportItem, type Snapshot, type SourceResult, type StatusEnvelope } from '@lx/shared';
import { Hono } from 'hono';
import {
  countCandidates,
  getEvents,
  getLastRun,
  getRuns,
  getSourceDaily,
  getSourceHistory,
  getSourcePlatformDaily,
} from './db';
import type { Env } from './env';
import { SNAPSHOT_KEY } from './env';
import { filterSnapshot, parseList } from './filter';
import { handleIngest } from './ingest';
import { isStale } from './merge';

type Ctx = { Bindings: Env };

const CACHE_PUBLIC = 'public, max-age=30, s-maxage=60';
const CACHE_DETAIL = 'public, max-age=60, s-maxage=120';

async function readSnapshot(env: Env): Promise<Snapshot | null> {
  const raw = await env.SNAPSHOT.get(SNAPSHOT_KEY);
  if (!raw) return null;
  try {
    return SnapshotSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

function notReady(): Response {
  return Response.json({ error: 'not_ready', message: '还没有任何检测结果，等待 Actions 首次上报' }, { status: 503 });
}

function notFound(message: string): Response {
  return Response.json({ error: 'not_found', message }, { status: 404 });
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function toExportItem(source: SourceResult): ExportItem {
  return {
    id: source.id,
    title: source.title,
    url: source.url,
    mirror: source.mirror,
    homepage: source.homepage,
    status: source.status,
    ok: source.stats.ok,
    tested: source.stats.tested,
    total: source.stats.total,
    platforms: source.platforms.map((platform) => ({
      key: platform.key,
      ok: platform.ok,
      tested: platform.tested,
      ms: platform.totalMs,
    })),
  };
}

function csvCell(value: unknown): string {
  const text = value === undefined || value === null ? '' : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function toCsv(items: ExportItem[]): string {
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

export function createApi(): Hono<Ctx> {
  const api = new Hono<Ctx>();

  api.post('/ingest', handleIngest);

  api.get('/status', async (c) => {
    const snapshot = await readSnapshot(c.env);
    if (!snapshot) return notReady();

    const filtered = filterSnapshot(snapshot, {
      platforms: parseList(c.req.query('platform')),
      statuses: parseList(c.req.query('status')),
      q: c.req.query('q'),
    });
    const envelope: StatusEnvelope = {
      snapshot: filtered,
      serverTime: new Date().toISOString(),
      stale: isStale(filtered.generatedAt),
    };
    return Response.json(envelope, { headers: { 'cache-control': CACHE_PUBLIC } });
  });

  api.get('/sources/:id', async (c) => {
    const snapshot = await readSnapshot(c.env);
    if (!snapshot) return notReady();

    const id = c.req.param('id');
    const source = snapshot.sources.find((item) => item.id === id);
    if (!source) return notFound(`未知来源：${id}`);

    const [history, daily, platformDaily] = await Promise.all([
      getSourceHistory(c.env.DB, id, 42),
      getSourceDaily(c.env.DB, id, 180),
      getSourcePlatformDaily(c.env.DB, id, 180),
    ]);

    return Response.json(
      { source, history, daily, platformDaily, generatedAt: snapshot.generatedAt },
      { headers: { 'cache-control': CACHE_DETAIL } },
    );
  });

  api.get('/history', async (c) => {
    const days = clampInt(c.req.query('days'), 14, 1, 90);
    const runs = await getRuns(c.env.DB, days * 6);
    return Response.json(runs, { headers: { 'cache-control': CACHE_DETAIL } });
  });

  api.get('/events', async (c) => {
    const limit = clampInt(c.req.query('limit'), 50, 1, 200);
    const events = await getEvents(c.env.DB, limit);
    return Response.json(events, { headers: { 'cache-control': CACHE_DETAIL } });
  });

  api.get('/export', async (c) => {
    const snapshot = await readSnapshot(c.env);
    if (!snapshot) return notReady();

    const items = snapshot.sources.map(toExportItem);
    const format = (c.req.query('format') ?? 'json').toLowerCase();
    if (format === 'csv') {
      return new Response(toCsv(items), {
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': 'attachment; filename="lx-source-watch.csv"',
          'cache-control': CACHE_PUBLIC,
        },
      });
    }
    return Response.json(items, {
      headers: {
        'content-disposition': 'attachment; filename="lx-source-watch.json"',
        'cache-control': CACHE_PUBLIC,
      },
    });
  });

  api.get('/health', async (c) => {
    const [snapshot, lastRun, candidates] = await Promise.all([
      readSnapshot(c.env),
      getLastRun(c.env.DB),
      countCandidates(c.env.DB),
    ]);
    const stale = lastRun ? isStale(lastRun.finishedAt) : true;
    return Response.json(
      {
        ok: Boolean(lastRun) && !stale,
        lastRun,
        stale,
        sources: snapshot?.sources.length ?? 0,
        candidates,
        serverTime: new Date().toISOString(),
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  });

  return api;
}
