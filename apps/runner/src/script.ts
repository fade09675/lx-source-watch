import { readFile } from 'node:fs/promises';
import { httpRequest, type ProxyConfig } from './net/http.js';
import { sha256Hex } from './util.js';
import type { ResolvedSource } from './registry.js';

export const MAX_SCRIPT_BYTES = 2 * 1024 * 1024;

export interface LoadedScript {
  code: string;
  bytes: number;
  sha: string;
  fromMirror: boolean;
  url: string;
  contentType?: string;
}

export interface LoadScriptOptions {
  proxy?: ProxyConfig;
  allowPrivate?: boolean;
  timeoutMs?: number;
  /** 先走镜像再走原地址（国内网络建议开启）。 */
  preferMirror?: boolean;
}

function looksLikeHtml(code: string, contentType: string): boolean {
  if (/text\/html/i.test(contentType)) return true;
  const head = code.slice(0, 200).trimStart().toLowerCase();
  return head.startsWith('<!doctype') || head.startsWith('<html');
}

/** 下载单个接入点并做大小/HTML/空内容检查（不初始化脚本）。 */
export async function fetchScriptText(url: string, opts: LoadScriptOptions): Promise<LoadedScript> {  const res = await httpRequest(url, {
    headers: {
      accept: 'application/javascript, text/javascript, */*;q=0.8',
    },
    timeoutMs: opts.timeoutMs ?? 20_000,
    maxBytes: MAX_SCRIPT_BYTES,
    proxy: opts.proxy,
    allowPrivate: opts.allowPrivate,
    maxRedirects: 5,
  });
  if (res.status !== 200) {
    throw new Error(`HTTP ${res.status}`);
  }
  if (res.truncated) {
    throw new Error(`脚本超过 ${Math.round(MAX_SCRIPT_BYTES / 1024)}KB 上限`);
  }
  const contentType = res.headers['content-type'] ?? '';
  const code = res.body.toString('utf8').replace(/^\uFEFF/, '');
  if (looksLikeHtml(code, contentType)) {
    throw new Error('返回的是 HTML 页面而不是脚本');
  }
  if (code.trim().length < 50) {
    throw new Error('脚本内容为空或过短');
  }
  return {
    code,
    bytes: Buffer.byteLength(code),
    sha: sha256Hex(code).slice(0, 16),
    fromMirror: false,
    url,
    contentType: contentType || undefined,
  };
}

/** 读取仓库内脚本（repo 来源的本地主地址）。 */
export async function readRepoScript(src: ResolvedSource): Promise<LoadedScript> {
  if (!src.localPath) throw new Error('内部错误：repo 来源缺少本地路径');
  const code = (await readFile(src.localPath, 'utf8')).replace(/^\uFEFF/, '');
  const bytes = Buffer.byteLength(code);
  if (bytes > MAX_SCRIPT_BYTES) throw new Error(`脚本超过 ${MAX_SCRIPT_BYTES / 1024}KB 上限`);
  if (code.trim().length < 50) throw new Error('脚本内容为空或过短');
  return {
    code,
    bytes,
    sha: sha256Hex(code).slice(0, 16),
    fromMirror: false,
    url: src.resolvedUrl,
  };
}

/**
 * 加载音源脚本：仓库内文件直接读磁盘；远程脚本按原地址 → 镜像 顺序回退。
 * 只做大小/HTML/空内容检查，语法错误留给沙箱初始化阶段。
 */
export async function loadScript(
  src: ResolvedSource,
  opts: LoadScriptOptions = {},
): Promise<LoadedScript> {
  if (src.storage === 'repo') {
    return readRepoScript(src);
  }

  const errors: string[] = [];
  const attempts: { url: string; mirror: boolean }[] = [];
  if (src.resolvedMirror && opts.preferMirror) {
    attempts.push({ url: src.resolvedMirror, mirror: true }, { url: src.resolvedUrl, mirror: false });
  } else {
    attempts.push({ url: src.resolvedUrl, mirror: false });
    if (src.resolvedMirror) attempts.push({ url: src.resolvedMirror, mirror: true });
  }

  for (const attempt of attempts) {
    try {
      const loaded = await fetchScriptText(attempt.url, opts);
      return { ...loaded, fromMirror: attempt.mirror };
    } catch (e) {
      errors.push(`${attempt.mirror ? '镜像' : '主地址'}：${(e as Error).message}`);
    }
  }
  throw new Error(`下载脚本失败（${errors.join('；')}）`);
}
