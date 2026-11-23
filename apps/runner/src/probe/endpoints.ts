import type { EndpointResult } from '@lx/shared';
import { parseScriptMeta } from '../lx/meta.js';
import type { ProxyConfig } from '../net/http.js';
import type { ResolvedSource } from '../registry.js';
import { fetchScriptText, readRepoScript } from '../script.js';
import { errorMessage, mapLimit, nowIso } from '../util.js';

/** 下载检查结果；code 只在进程内用于初始化，不写入快照。 */
export interface EndpointCheck extends EndpointResult {
  code?: string;
}

export interface CheckEndpointsOptions {
  proxy?: ProxyConfig;
  allowPrivate?: boolean;
  timeoutMs?: number;
  /** 镜像超时默认比主地址短，避免一个坏镜像拖慢整轮。 */
  mirrorTimeoutMs?: number;
  concurrency?: number;
}

function statusFromError(message: string): number | undefined {
  const match = /HTTP (\d{2,3})/.exec(message);
  return match ? Number(match[1]) : undefined;
}

/**
 * 逐个接入点下载脚本并比对内容指纹。
 * 平台测试只需一个可用接入点；其余候选只做下载检查，用于“版本同步/落后”判断。
 */
export async function checkEndpoints(
  src: ResolvedSource,
  options: CheckEndpointsOptions = {},
): Promise<EndpointCheck[]> {
  const checks = await mapLimit(src.endpoints, Math.max(1, options.concurrency ?? 3), async (endpoint): Promise<EndpointCheck> => {
    const started = Date.now();
    try {
      const loaded =
        src.storage === 'repo' && endpoint.role === 'primary' && src.localPath
          ? await readRepoScript(src)
          : await fetchScriptText(endpoint.url, {
              proxy: options.proxy,
              allowPrivate: options.allowPrivate,
              timeoutMs:
                endpoint.role === 'primary'
                  ? (options.timeoutMs ?? 20_000)
                  : Math.min(options.timeoutMs ?? 20_000, options.mirrorTimeoutMs ?? 8_000),
              preferMirror: false,
            });
      const meta = parseScriptMeta(loaded.code, `${src.id}.js`);
      return {
        url: endpoint.url,
        role: endpoint.role,
        ok: true,
        sha: loaded.sha,
        bytes: loaded.bytes,
        version: meta.version?.slice(0, 40),
        ms: Date.now() - started,
        checkedAt: nowIso(),
        code: loaded.code,
      } satisfies EndpointCheck;
    } catch (error) {
      const message = errorMessage(error);
      return {
        url: endpoint.url,
        role: endpoint.role,
        ok: false,
        status: statusFromError(message),
        ms: Date.now() - started,
        error: message.slice(0, 280),
        checkedAt: nowIso(),
      } satisfies EndpointCheck;
    }
  });

  const primarySha = checks.find((item) => item.role === 'primary' && item.ok)?.sha;
  for (const check of checks) {
    if (!check.ok) continue;
    check.versionState = !primarySha ? 'unknown' : check.sha === primarySha ? 'synced' : 'lagging';
  }
  return checks;
}

export interface ChosenEndpoint {
  check: EndpointCheck;
  /** 主地址不可用或版本不一致时的说明。 */
  warning?: string;
}

/**
 * 选路顺序：主地址（可用且与自身同版本）→ 已同步镜像 → 任一可下载的落后镜像。
 * 绝不因为镜像多就跳过主地址。
 */
export function chooseEndpoint(checks: EndpointCheck[]): ChosenEndpoint | undefined {
  const primary = checks.find((item) => item.role === 'primary');
  if (primary?.ok) return { check: primary };

  const synced = checks.find((item) => item.role === 'candidate' && item.ok && item.versionState === 'synced');
  if (synced) return { check: synced, warning: '主地址不可用，已改用同版本镜像' };

  const fallback = checks.find((item) => item.ok);
  if (fallback) {
    return {
      check: fallback,
      warning: primary ? '主地址不可用，已改用版本不一致的镜像（结果仅供参考）' : '主地址不可用，已改用镜像（无法比对版本）',
    };
  }
  return undefined;
}

/** 快照只保留可序列化字段。 */
export function toEndpointResults(checks: EndpointCheck[]): EndpointResult[] {
  return checks.map(({ code: _code, ...rest }) => rest);
}

export function describeEndpointFailure(checks: EndpointCheck[]): string {
  const failed = checks.filter((item) => !item.ok);
  if (failed.length === 0) return '没有可用接入点';
  const first = failed[0] as EndpointCheck;
  return `所有接入点均不可用：${failed.length} 个失败（首个：${first.error ?? '未知错误'}）`;
}
