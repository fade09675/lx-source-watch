import type { D1Database } from '@cloudflare/workers-types';
import { parseGitHubRawUrl, renderMirror, type Candidate } from '@lx/shared';
import { ensureCandidateSha } from './candidateSha';
import { getCandidate, getCandidates, setCandidateState } from './db';
import { getMirrorTemplates } from './mirrors';
import { createSourceRegistry, findSourceRegistryByUrl } from './sourceRegistry';
import { loadSettings } from './settings';
import { decideDuplicate } from './dedup';
import { markCandidateDuplicate, mergeIntoCanonical } from './mergeSources';

export interface PromotionResult {
  promoted: string[];
  skipped: number;
  errors: string[];
}

export interface SinglePromotion {
  ok: boolean;
  id?: string;
  error?: string;
  existing?: boolean;
}

/** 把候选的 raw 地址按当前镜像模板展开成一组加速地址。 */
export async function suggestedMirrors(db: D1Database, url: string): Promise<string[]> {
  const parts = parseGitHubRawUrl(url);
  if (!parts) return [];
  const config = await getMirrorTemplates(db);
  const out: string[] = [];
  const seen = new Set([url]);
  for (const template of config.templates) {
    if (!template.enabled) continue;
    const rendered = renderMirror(template.template, { ...parts, url });
    if (!rendered || seen.has(rendered)) continue;
    seen.add(rendered);
    out.push(rendered);
    if (out.length >= 8) break;
  }
  return out;
}

async function promoteOne(
  env: { DB: D1Database },
  candidate: Candidate,
  now: string,
): Promise<SinglePromotion> {
  // 老候选没有指纹：收录前自动下载补算，避免重复内容被当成新源。
  // 放在“同地址已存在”判断之前，保证这类候选也会补上指纹。
  const sha256 = candidate.sha256 ?? (await ensureCandidateSha(env.DB, candidate));

  const existing = await findSourceRegistryByUrl(env.DB, candidate.url);
  if (existing) {
    await setCandidateState(env.DB, candidate.id, 'promoted', now);
    return { ok: true, id: existing.id, existing: true };
  }

  // 内容指纹相同视为重复：并入主源、写别名、把候选标为 duplicate，不再新建源。
  if (sha256) {
    const decision = await decideDuplicate(env.DB, {
      kind: 'candidate',
      url: candidate.url,
      sha256,
      title: candidate.title ?? '',
      author: candidate.author ?? '',
    });
    const canonical = decision.canonical;
    if (canonical && canonical.id !== candidate.id && decision.action === 'alias' && canonical.kind === 'registry') {
      await markCandidateDuplicate(env.DB, candidate.id, canonical.id, now);
      await mergeIntoCanonical(env.DB, canonical.id, [{ url: candidate.url, sha256 }], now);
      return { ok: true, id: canonical.id, existing: true };
    }
    if (canonical && canonical.id !== candidate.id && decision.action === 'merge_candidates' && canonical.kind === 'candidate') {
      await markCandidateDuplicate(env.DB, candidate.id, canonical.id, now);
      return { ok: true, id: canonical.id, existing: true };
    }
  }
  const created = await createSourceRegistry(
    env.DB,
    {
      id: candidate.id,
      title: candidate.title?.trim() || candidate.id,
      category: '自动发现',
      url: candidate.url,
      homepage: '',
      mirrors: await suggestedMirrors(env.DB, candidate.url),
      contentSha256: sha256 ?? null,
      enabled: true,
      trusted: false,
      notes: `自动收录：${candidate.repo}/${candidate.path}`,
    },
    now,
  );
  if (!created.ok) return { ok: false, error: created.errors.join('；') };
  await setCandidateState(env.DB, candidate.id, 'promoted', now);
  return { ok: true, id: created.row.id };
}

/** 手动“收录”单个候选：直接进正式清单，不要求初始化通过（由用户判断）。 */
export async function promoteCandidate(
  env: { DB: D1Database },
  id: string,
  now = new Date().toISOString(),
): Promise<SinglePromotion> {
  const candidate = await getCandidate(env.DB, id);
  if (!candidate) return { ok: false, error: '候选不存在' };
  return promoteOne(env, candidate, now);
}

/**
 * 无人值守收录：初始化通过、声明了平台、且还没进正式清单的候选，
 * 按设置自动转成正式音源（默认每轮最多 3 个）。
 */
export async function autoPromoteCandidates(env: { DB: D1Database }, now = new Date().toISOString()): Promise<PromotionResult> {
  const settings = await loadSettings(env.DB);
  const result: PromotionResult = { promoted: [], skipped: 0, errors: [] };
  if (!settings.autoPromoteCandidates) return result;

  const qualified = await getCandidates(env.DB, { state: 'qualified', limit: 60 });
  for (const candidate of qualified) {
    if (result.promoted.length >= settings.autoPromoteMaxPerRun) break;
    if (candidate.initOk !== true) continue;
    if (!candidate.platforms?.length) continue;

    try {
      const outcome = await promoteOne(env, candidate, now);
      if (!outcome.ok) {
        result.errors.push(`${candidate.id}: ${outcome.error ?? '收录失败'}`);
        continue;
      }
      if (outcome.existing) result.skipped += 1;
      else if (outcome.id) result.promoted.push(outcome.id);
    } catch (error) {
      result.errors.push(`${candidate.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return result;
}
