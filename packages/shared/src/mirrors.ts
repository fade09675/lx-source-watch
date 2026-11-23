import { z } from 'zod';

/** 从 GitHub raw 地址拆出模板变量。 */
export interface GitHubRawParts {
  owner: string;
  repo: string;
  branch: string;
  path: string;
}

export function parseGitHubRawUrl(url: string): GitHubRawParts | null {
  const prefix = 'https://raw.githubusercontent.com/';
  if (!url.startsWith(prefix)) return null;
  const [owner, repo, branch, ...rest] = url.slice(prefix.length).split('/');
  if (!owner || !repo || !branch || rest.length === 0) return null;
  return { owner, repo, branch, path: rest.join('/') };
}

export const MIRROR_TEMPLATES_KEY = 'mirror.templates';
export const MIRROR_TEMPLATE_LIMIT = 10;

export interface MirrorTemplate {
  id: string;
  name: string;
  template: string;
  enabled: boolean;
}

export const MirrorTemplateSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9][a-z0-9_-]*$/, '只能用小写字母、数字、- 和 _'),
  name: z.string().min(1).max(40),
  template: z.string().min(8).max(300),
  enabled: z.boolean().default(true),
});

export const MirrorTemplateListSchema = z.array(MirrorTemplateSchema).max(MIRROR_TEMPLATE_LIMIT);

const TEMPLATE_PARTS = ['{owner}', '{repo}', '{branch}', '{path}'] as const;

/** 返回模板的错误说明；合法时返回 undefined。 */
export function templateError(template: string): string | null {
  if (!/^https:\/\//i.test(template)) return '必须以 https:// 开头';
  if (/\s/.test(template)) return '不能包含空格或换行';
  const hasUrl = template.includes('{url}');
  const hasParts = TEMPLATE_PARTS.every((part) => template.includes(part));
  if (!hasUrl && !hasParts) return '需要包含 {url}，或同时包含 {owner}/{repo}/{branch}/{path}';
  return null;
}

export function renderMirror(template: string, parts: GitHubRawParts & { url: string }): string {
  return template
    .replaceAll('{url}', parts.url)
    .replaceAll('{owner}', parts.owner)
    .replaceAll('{repo}', parts.repo)
    .replaceAll('{branch}', parts.branch)
    .replaceAll('{path}', parts.path);
}

/** 内置默认模板；首次使用或“恢复默认”时生效。顺序即探测顺序。 */
export const DEFAULT_MIRROR_TEMPLATES: MirrorTemplate[] = [
  { id: 'gh-proxy', name: 'gh-proxy', template: 'https://gh-proxy.com/{url}', enabled: true },
  { id: 'ghfast', name: 'ghfast', template: 'https://ghfast.top/{url}', enabled: true },
  { id: 'githack', name: 'githack', template: 'https://raw.githack.com/{owner}/{repo}/{branch}/{path}', enabled: true },
  {
    id: 'githack-cdn',
    name: 'githack CDN',
    template: 'https://rawcdn.githack.com/{owner}/{repo}/{branch}/{path}',
    enabled: true,
  },
  {
    id: 'jsdelivr',
    name: 'jsDelivr',
    template: 'https://cdn.jsdelivr.net/gh/{owner}/{repo}@{branch}/{path}',
    enabled: true,
  },
  {
    id: 'jsdelivr-gcore',
    name: 'jsDelivr Gcore',
    template: 'https://gcore.jsdelivr.net/gh/{owner}/{repo}@{branch}/{path}',
    enabled: true,
  },
  {
    id: 'jsdelivr-fastly',
    name: 'jsDelivr Fastly',
    template: 'https://fastly.jsdelivr.net/gh/{owner}/{repo}@{branch}/{path}',
    enabled: true,
  },
  {
    id: 'jsdelivr-testingcf',
    name: 'jsDelivr TestingCF',
    template: 'https://testingcf.jsdelivr.net/gh/{owner}/{repo}@{branch}/{path}',
    enabled: true,
  },
];
