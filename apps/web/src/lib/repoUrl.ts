export type RepoUrlImport = {
  repo: string;
  branch: string;
  pathPrefixes: string[];
};

export class RepoUrlError extends Error {}

const OWNER_PATTERN = /^[A-Za-z0-9_.-]+$/;

function fail(message: string): never {
  throw new RepoUrlError(message);
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Parse common GitHub repository links into the fields used by discovery repos.
 * Supported: https://github.com/owner/repo[/tree/<branch>[/path]]
 *            git@github.com:owner/repo.git
 *            owner/repo
 */
export function parseRepoUrl(raw: string, fallbackBranch = 'main'): RepoUrlImport {
  let input = raw.trim();
  if (!input) fail('请先粘贴 GitHub 仓库链接');

  if (input.startsWith('<') && input.endsWith('>')) input = input.slice(1, -1).trim();
  if (input.startsWith('git@github.com:')) {
    input = `https://github.com/${input.slice('git@github.com:'.length)}`;
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
    input = input.replace(/^github\.com\//i, '').replace(/^www\.github\.com\//i, '');
    if (/^[^/]+\/[^/]+/.test(input)) input = `https://github.com/${input}`;
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    fail('无法识别这个地址，请粘贴 GitHub 仓库主页或 /tree/分支/目录 链接');
  }

  const host = url.hostname.toLowerCase();
  if (host !== 'github.com' && host !== 'www.github.com') {
    fail('只支持 github.com 仓库链接');
  }

  const segments = url.pathname
    .split('/')
    .filter(Boolean)
    .map((segment) => safeDecode(segment));
  if (segments.length < 2) fail('链接里缺少 owner/repo');

  const owner = segments[0] ?? '';
  const name = (segments[1] ?? '').replace(/\.git$/i, '');
  if (!OWNER_PATTERN.test(owner) || !OWNER_PATTERN.test(name)) {
    fail('owner 或仓库名格式不正确');
  }

  const repo = `${owner}/${name}`;
  const route = segments[2];
  let branch = (fallbackBranch || 'main').trim() || 'main';
  const pathPrefixes: string[] = [];

  if (route === 'blob') {
    fail('这是文件链接，请粘贴仓库主页或目录链接');
  }

  if (route === 'tree') {
    if (!segments[3]) fail('/tree/ 后面缺少分支名，请粘贴到具体目录');
    branch = safeDecode(segments[3]).trim();
    if (!branch) fail('分支名为空');
    const path = segments.slice(4).join('/').replace(/^\/+|\/+$/g, '');
    if (path) pathPrefixes.push(path);
  } else if (segments.length > 2) {
    fail('无法识别链接里的路径，请使用仓库主页或 /tree/分支/目录 形式');
  }

  return { repo, branch, pathPrefixes };
}
