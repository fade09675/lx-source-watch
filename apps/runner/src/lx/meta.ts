export interface LxMeta {
  name?: string;
  version?: string;
  author?: string;
  description?: string;
  homepage?: string;
  expire?: string;
  support: string[];
}

/**
 * 解析 LX 自定义源头部的注释元数据。
 * 只扫描前 8000 字符，避免大文件里正文的 @ 干扰。
 */
export function parseScriptMeta(code: string, filename = 'source.js'): LxMeta {
  const header = code.slice(0, 8000);
  const meta: LxMeta = { support: [] };
  const re = /^[\s/*#-]*@([a-zA-Z][\w-]*)\s*[:=]?\s*(.+?)\s*(?:\*\/)?\s*$/gm;
  for (const match of header.matchAll(re)) {
    const key = (match[1] ?? '').toLowerCase();
    let value = (match[2] ?? '').trim();
    if (!key || !value) continue;
    value = value.replace(/\s*\*\/\s*$/, '').trim();
    if (key === 'support') {
      meta.support = value
        .split(/[,，\s]+/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      continue;
    }
    if (key === 'name' || key === 'version' || key === 'author' || key === 'description' || key === 'homepage' || key === 'expire') {
      (meta as unknown as Record<string, string>)[key] = value;
    }
  }
  if (!meta.name) meta.name = filename.replace(/\.js$/i, '');
  return meta;
}

export function scriptInfo(meta: LxMeta, rawScript: string, filename: string): Record<string, unknown> {
  return {
    name: meta.name,
    description: meta.description ?? '',
    version: meta.version ?? '',
    author: meta.author ?? '',
    homepage: meta.homepage ?? '',
    rawScript,
    filename,
  };
}
