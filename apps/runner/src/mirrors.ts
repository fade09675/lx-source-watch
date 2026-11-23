import { DEFAULT_MIRROR_TEMPLATES, MirrorTemplateListSchema, type MirrorTemplate } from '@lx/shared';
import { log } from './logger.js';
import { errorMessage } from './util.js';

export interface LoadMirrorTemplatesOptions {
  configUrl?: string;
  timeoutMs?: number;
}

let cache: MirrorTemplate[] | null = null;

export function resetMirrorTemplateCache(): void {
  cache = null;
}

function defaultConfigUrl(): string {
  if (process.env.LX_CONFIG_URL) return process.env.LX_CONFIG_URL;
  if (process.env.GITHUB_ACTIONS === 'true') return 'https://dash.dpdns.org/api/config/mirrors';
  return '';
}

/**
 * 从 Worker 拉取管理员配置的加速镜像模板；失败时回退内置默认。
 * 只读公开接口，不需要任何密钥，因此 probe 任务仍保持零机密。
 */
export async function loadMirrorTemplates(options: LoadMirrorTemplatesOptions = {}): Promise<MirrorTemplate[]> {
  if (cache) return cache;
  const url = options.configUrl ?? defaultConfigUrl();
  if (!url) return DEFAULT_MIRROR_TEMPLATES;

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(options.timeoutMs ?? 3_000),
      headers: { accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as { templates?: unknown };
    const templates = MirrorTemplateListSchema.parse(body.templates);
    const enabled = templates.filter((template) => template.enabled);
    cache = enabled;
    log.info(`镜像模板：从 ${url} 读取 ${enabled.length} 条`);
    return enabled;
  } catch (error) {
    log.warn(`读取镜像模板失败：${errorMessage(error)}，使用内置默认 ${DEFAULT_MIRROR_TEMPLATES.length} 条`);
    return DEFAULT_MIRROR_TEMPLATES;
  }
}
