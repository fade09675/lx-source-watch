import { readFile, stat } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { RegistrySchema, type RegistrySource } from '@lx/shared';

export interface ResolvedSource extends RegistrySource {
  /** 实际用于探测的 URL（remote=原始 url，repo=raw.githubusercontent）。 */
  resolvedUrl: string;
  /** 备用镜像（ghproxy 等）。 */
  resolvedMirror?: string;
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
 * 远程源未显式配置 mirror 时，给 GitHub raw 自动补一个 ghproxy 镜像。
 * 境外跑 Actions 仍优先用原地址；国内本地可用 --prefer-mirror 先走镜像。
 */
export function defaultMirror(url: string): string | undefined {
  if (url.startsWith('https://raw.githubusercontent.com/')) {
    return `https://ghproxy.net/${url}`;
  }
  return undefined;
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
      resolved.push({
        ...entry,
        localPath,
        repoPath,
        resolvedUrl: `${rawBase}/${encodePath(repoPath)}`,
        resolvedMirror: `https://ghproxy.net/${rawBase}/${encodePath(repoPath)}`,
      });
    } else {
      if (!entry.url) throw new Error(`来源 ${entry.id} 缺少 url`);
      resolved.push({
        ...entry,
        resolvedUrl: entry.url,
        resolvedMirror: entry.mirror ?? defaultMirror(entry.url),
      });
    }
  }

  if (resolved.length === 0) {
    throw new Error('来源清单为空（检查 enabled / --only 过滤条件）');
  }
  return resolved;
}

export { encodePath };
