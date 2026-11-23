import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  CandidateFileSchema,
  type Candidate,
  type CandidateFile,
} from '@lx/shared';
import { parseScriptMeta } from './lx/meta.js';
import { loadLxSource } from './lx/sandbox.js';
import { log } from './logger.js';
import type { ProxyConfig } from './net/http.js';
import { loadScript } from './script.js';
import { errorMessage, mapLimit, nowIso } from './util.js';

export interface EnrichOptions {
  candidatesPath: string;
  outPath?: string;
  limit?: number;
  concurrency?: number;
  proxy?: ProxyConfig;
  initTimeoutMs?: number;
  scriptTimeoutMs?: number;
}

/**
 * 对候选脚本做一次“能不能初始化”的静态体检（不取链、不拉流）。
 * 只处理 state=new/qualified 的前 N 个，避免每轮把 GitHub 与平台接口打爆。
 */
export async function enrichCandidates(opts: EnrichOptions): Promise<CandidateFile> {
  const raw = await readFile(opts.candidatesPath, 'utf8');
  const file = CandidateFileSchema.parse(JSON.parse(raw));
  const limit = Math.max(0, opts.limit ?? 12);
  const targets = file.candidates.filter((c) => c.state === 'new' || c.state === 'qualified').slice(0, limit);
  log.step(`候选体检 ${targets.length}/${file.candidates.length} 个`);

  const updated = new Map<string, Candidate>();
  const results = await mapLimit(targets, Math.max(1, opts.concurrency ?? 3), async (candidate) => {
    const started = Date.now();
    try {
      const script = await loadScript(
        {
          id: candidate.id,
          title: candidate.title ?? candidate.id,
          storage: 'remote',
          category: '候选',
          enabled: true,
          trusted: false,
          resolvedUrl: candidate.url,
        },
        { proxy: opts.proxy, timeoutMs: 20_000 },
      );
      const meta = parseScriptMeta(script.code, `${candidate.id}.js`);
      const loaded = await loadLxSource({
        code: script.code,
        filename: `${candidate.id}.js`,
        initTimeoutMs: opts.initTimeoutMs ?? 12_000,
        scriptTimeoutMs: opts.scriptTimeoutMs ?? 15_000,
        proxy: opts.proxy,
      });
      const platforms = Object.keys(loaded.sources);
      loaded.dispose();
      const next: Candidate = {
        ...candidate,
        title: meta.name ?? candidate.title,
        version: meta.version ?? candidate.version,
        author: meta.author ?? candidate.author,
        description: meta.description ?? candidate.description,
        platforms,
        bytes: script.bytes,
        initOk: true,
        initError: undefined,
        state: 'qualified',
        lastSeen: nowIso(),
      };
      log.info(`✓ ${candidate.id} ${meta.name ?? candidate.path}（${platforms.join('/') || '无平台'}，${Date.now() - started}ms）`);
      return next;
    } catch (e) {
      const message = errorMessage(e);
      const next: Candidate = {
        ...candidate,
        initOk: false,
        initError: message.slice(0, 300),
        state: 'new',
        lastSeen: nowIso(),
      };
      log.debug(`× ${candidate.id}: ${message}`);
      return next;
    }
  });

  for (const item of results) updated.set(item.id, item);
  const merged: CandidateFile = {
    version: 1,
    generatedAt: nowIso(),
    candidates: file.candidates.map((c) => updated.get(c.id) ?? c),
  };
  const outPath = opts.outPath ?? opts.candidatesPath;
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  const ok = results.filter((c) => c.initOk).length;
  log.success(`候选体检完成：${ok}/${results.length} 可初始化，结果写入 ${outPath}`);
  return merged;
}
