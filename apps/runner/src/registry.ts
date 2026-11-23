import { readFile, stat } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import {
  DEFAULT_MIRROR_TEMPLATES,
  RegistrySchema,
  parseGitHubRawUrl,
  renderMirror,
  type MirrorTemplate,
  type RegistrySource,
} from '@lx/shared';

export interface ResolvedEndpoint {
  url: string;
  role: 'primary' | 'candidate';
}

export interface ResolvedSource extends RegistrySource {
  /** 实际用于探测的 URL（remote=原始 url，repo=raw.githubusercontent）。 */
  resolvedUrl: string;
  /** 备用镜像（ghproxy 等）。 */
  resolvedMirror?: string;
  /** 全部接入点：主地址在前，镜像/加速候选在后。 */
  endpoints: ResolvedEndpoint[];
  /** repo 来源的本地绝对路径。 */
  localPath?: string;
  /** repo 来源相对仓库根的路径（posix 分隔符）。 */
  repoPath?: string;
}

export interface LoadRegistryOptions {
  only?: string[];
  limit?: number;
  includeDisabled?: boolean;
  repoRoot?: string;
  rawBase?: string;
  /** 加速镜像模板；不传时使用内置默认。 */
  mirrorTemplates?: MirrorTemplate[];
}

function formatIssues(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return error.issues
    .slice(0, 8)
    .map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`)
    .join('；');
}

function rawBaseFromEnv(): string {
  if (process.env.RAW_BASE) return process.env.RAW_BASE.replace(/\/$/, '');
  const slug = process.env.GITHUB_REPOSITORY || 'lx-source-watch/lx-source-watch';
  return `https://raw.githubusercontent.com/${slug}/main`;
}

function encodePath(p: string): string {
  return p
    .split('/')
    .filter(Boolean)
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

/**
 * 远程源未显式配置 mirror 时的旧兼容字段；新逻辑统一走 endpoints。
 * 保留此函数只为兼容早期调用方。
 */
export function defaultMirror(url: string): string | undefined {
  if (url.startsWith('https://raw.githubusercontent.com/')) {
    return `https://ghproxy.net/${url}`;
  }
  return undefined;
}

/**
 * 按模板展开加速地址。只生成、不默认启用；
 * 探测阶段会逐个下载并按 sha 判断是否与主地址同版本。
 */
export function suggestedMirrors(url: string, templates: MirrorTemplate[] = DEFAULT_MIRROR_TEMPLATES): string[] {
  const raw = parseGitHubRawUrl(url);
  if (!raw) return [];
  const parts = { ...raw, url };
  const seen = new Set<string>();
  const mirrors: string[] = [];
  for (const template of templates) {
    if (!template.enabled) continue;
    const rendered = renderMirror(template.template, parts);
    if (seen.has(rendered)) continue;
    seen.add(rendered);
    mirrors.push(rendered);
  }
  return mirrors;
}

function resolveEndpoints(primary: string, explicit: string[], suggested: string[]): ResolvedEndpoint[] {
  const seen = new Set<string>();
  const endpoints: ResolvedEndpoint[] = [];
  const push = (url: string, role: ResolvedEndpoint['role']) => {
    if (!url || seen.has(url) || endpoints.length >= 12) return;
    seen.add(url);
    endpoints.push({ url, role });
  };
  push(primary, 'primary');
  for (const url of explicit) push(url, 'candidate');
  for (const url of suggested) push(url, 'candidate');
  return endpoints;
}

export async function loadRegistry(
  registryPath: string,
  opts: LoadRegistryOptions = {},
): Promise<ResolvedSource[]> {
  let raw: string;
  try {
    raw = await readFile(registryPath, 'utf8');
  } catch {
    throw new Error(`读取来源清单失败：${registryPath}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new Error(`来源清单不是合法 JSON：${registryPath}（${(e as Error).message}）`);
  }
  const parsed = RegistrySchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`来源清单校验失败：${formatIssues(parsed.error)}`);
  }

  const repoRoot = resolve(opts.repoRoot ?? process.env.LX_REPO_ROOT ?? process.cwd());
  const mirrorTemplates = opts.mirrorTemplates ?? DEFAULT_MIRROR_TEMPLATES;
  const rawBase = (opts.rawBase ?? rawBaseFromEnv()).replace(/\/$/, '');
  const only = opts.only?.length ? new Set(opts.only) : undefined;

  const resolved: ResolvedSource[] = [];
  for (const entry of parsed.data.sources) {
    if (!entry.enabled && !opts.includeDisabled) continue;
    if (only && !only.has(entry.id)) continue;
    if (opts.limit && resolved.length >= opts.limit) break;

    if (entry.storage === 'repo') {
      const localPath = resolve(repoRoot, entry.path ?? '');
      if (!localPath.startsWith(repoRoot + sep)) {
        throw new Error(`来源 ${entry.id} 的 path 越界：${entry.path}`);
      }
      try {
        const info = await stat(localPath);
        if (!info.isFile()) throw new Error('not a file');
      } catch {
        throw new Error(`来源 ${entry.id} 的本地脚本不存在：${entry.path}`);
      }
      const repoPath = relative(repoRoot, localPath).split(sep).join('/');
      const primary = `${rawBase}/${encodePath(repoPath)}`;
      const endpoints = resolveEndpoints(
        primary,
        [...(entry.mirrors ?? []), ...(entry.mirror ? [entry.mirror] : [])],
        suggestedMirrors(primary, mirrorTemplates),
      );
      resolved.push({
        ...entry,
        localPath,
        repoPath,
        resolvedUrl: primary,
        resolvedMirror: endpoints[1]?.url,
        endpoints,
      });
    } else {
      if (!entry.url) throw new Error(`来源 ${entry.id} 缺少 url`);
      const explicit = [...(entry.mirrors ?? []), ...(entry.mirror ? [entry.mirror] : [])];
      const endpoints = resolveEndpoints(entry.url, explicit, suggestedMirrors(entry.url, mirrorTemplates));
      resolved.push({
        ...entry,
        resolvedUrl: entry.url,
        resolvedMirror: endpoints[1]?.url,
        endpoints,
      });
    }
  }

  if (resolved.length === 0) {
    throw new Error('来源清单为空（检查 enabled / --only 过滤条件）');
  }
  return resolved;
}

export { encodePath };
