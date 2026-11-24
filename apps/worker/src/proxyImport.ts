/** 解析代理订阅文本：URI / host:port / Clash YAML / sing-box JSON / Base64。 */

export interface ParsedProxy {
  name: string;
  protocol: string;
  host: string;
  port: number;
  username: string;
  password: string;
  kernelOnly: boolean;
  config?: string;
}

export interface ParseResult {
  nodes: ParsedProxy[];
  warnings: string[];
}

const PLAIN = new Set(['http', 'https', 'socks5', 'socks5h']);
const KERNEL = new Set(['vmess', 'vless', 'trojan', 'hysteria2', 'ss', 'tuic', 'anytls']);

export function isKernelProtocol(protocol: string): boolean {
  return KERNEL.has(protocol.toLowerCase());
}

/** 判断单行文本是不是“订阅地址”而不是代理节点。 */
export function isSubscriptionUrl(raw: string): boolean {
  const text = raw.trim();
  if (!text || /\s/.test(text)) return false;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  // 没有端口、或带路径/查询参数 → 视为订阅地址；HTTP 代理必须显式写端口。
  if (!url.port) return true;
  if (url.pathname !== '/' && url.pathname !== '') return true;
  if (url.search) return true;
  return false;
}

function normalizeProtocol(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  if (value === 'socks') return 'socks5';
  if (value === 'hy2') return 'hysteria2';
  if (value === 'shadowsocks') return 'ss';
  if (PLAIN.has(value) || KERNEL.has(value)) return value;
  return null;
}

function emptyNode(protocol: string, name: string): ParsedProxy {
  return { name, protocol, host: '', port: 0, username: '', password: '', kernelOnly: !PLAIN.has(protocol) };
}

export function parseProxyUri(raw: string): ParsedProxy | null {
  const text = raw.trim();
  if (!text || text.startsWith('//')) return null;
  if (isSubscriptionUrl(text)) return null;
  const hashIndex = text.indexOf('#');
  const label = hashIndex >= 0 ? decodeURIComponent(text.slice(hashIndex + 1)) : '';
  const base = hashIndex >= 0 ? text.slice(0, hashIndex) : text;
  try {
    const url = new URL(base);
    const protocol = normalizeProtocol(url.protocol.replace(':', ''));
    if (!protocol) return null;
    // HTTP/SOCKS 代理必须有显式端口；订阅地址已经在上一步排除。
    if (PLAIN.has(protocol) && !url.port) return null;
    const node = emptyNode(protocol, label || protocol);
    node.host = url.hostname;
    node.port = Number(url.port) || 0;
    node.username = decodeURIComponent(url.username || '');
    node.password = decodeURIComponent(url.password || '');
    if (node.kernelOnly) node.config = text;
    return node;
  } catch {
    return null;
  }
}

/**
 * Surge / Loon / Quantumult X 单行格式：
 * - `名字 = socks5, 1.2.3.4, 1080, user, pass`
 * - `socks5=1.2.3.4:1080, username=user, password=pass, tag=名字`
 * 只解析可直接测活的 http/socks5；内核协议保留原文，避免字段丢失。
 */
export function parseClientLine(raw: string): ParsedProxy | null {
  const text = raw.trim();
  if (!text || text.includes('://') || !text.includes('=')) return null;

  const qx = /^(http|https|socks5)\s*=\s*([^,]+)\s*,\s*(.*)$/i.exec(text);
  if (qx) {
    const address = qx[2]?.trim() ?? '';
    const [host, portText] = address.split(':');
    const port = Number(portText);
    if (!host || !Number.isFinite(port) || port <= 0) return null;
    const pairs = Object.fromEntries(
      (qx[3] ?? '')
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
          const index = part.indexOf('=');
          return index > 0 ? [part.slice(0, index).trim().toLowerCase(), part.slice(index + 1).trim()] : ['', part];
        })
        .filter(([key]) => key),
    ) as Record<string, string>;
    const node = emptyNode(qx[1]!.toLowerCase(), pairs.tag || pairs.name || host);
    node.host = host;
    node.port = port;
    node.username = pairs.username || pairs.user || '';
    node.password = pairs.password || pairs.pass || '';
    return node;
  }

  const surge = /^([^=]+?)\s*=\s*(http|https|socks5)\s*,\s*(.+)$/i.exec(text);
  if (surge) {
    const parts = (surge[3] ?? '').split(',').map((part) => part.trim());
    const host = parts[0] ?? '';
    const port = Number(parts[1]);
    if (!host || !Number.isFinite(port) || port <= 0) return null;
    const node = emptyNode(surge[2]!.toLowerCase(), surge[1]!.trim() || host);
    node.host = host;
    node.port = port;
    node.username = parts[2] ?? '';
    node.password = parts[3] ?? '';
    return node;
  }

  return null;
}

export function parseHostPortLine(raw: string): ParsedProxy | null {
  const text = raw.trim();
  if (!text || text.includes('://')) return null;
  const hashIndex = text.indexOf('#');
  const label = hashIndex >= 0 ? decodeURIComponent(text.slice(hashIndex + 1)) : '';
  const base = hashIndex >= 0 ? text.slice(0, hashIndex) : text;
  const parts = base.split(':');
  if (parts.length < 2) return null;
  const host = parts[0]?.trim();
  const port = Number(parts[1]);
  if (!host || !Number.isFinite(port) || port <= 0 || port > 65_535) return null;
  const node = emptyNode('http', label || host);
  node.host = host;
  node.port = port;
  if (parts.length >= 4) {
    node.username = parts[2]?.trim() ?? '';
    node.password = parts.slice(3).join(':').trim();
  }
  return node;
}

function unquote(value: string): string {
  const text = value.trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}

function nodeFromRecord(record: Record<string, unknown>, fallbackName: string): ParsedProxy | null {
  const protocol = normalizeProtocol(String(record.type ?? record.protocol ?? ''));
  if (!protocol) return null;
  const node = emptyNode(protocol, String(record.name ?? record.tag ?? fallbackName));
  node.host = String(record.server ?? record.host ?? record.address ?? '');
  node.port = Number(record.port ?? record.server_port) || 0;
  node.username = String(record.username ?? record.user ?? '');
  node.password = String(record.password ?? record.pass ?? '');
  if (node.kernelOnly) node.config = JSON.stringify(record);
  if (!node.host || !node.port) return null;
  return node;
}

function parseJson(text: string): ParseResult | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    const list = Array.isArray(parsed)
      ? parsed
      : ((parsed as { proxies?: unknown[] }).proxies ?? (parsed as { outbounds?: unknown[] }).outbounds);
    if (!Array.isArray(list)) return null;
    const nodes: ParsedProxy[] = [];
    const warnings: string[] = [];
    list.forEach((item, index) => {
      if (!item || typeof item !== 'object') return;
      const node = nodeFromRecord(item as Record<string, unknown>, `json-${index + 1}`);
      if (node) nodes.push(node);
      else warnings.push(`第 ${index + 1} 条 JSON 节点无法识别`);
    });
    return { nodes, warnings };
  } catch {
    return null;
  }
}

function parseClashYaml(text: string): ParseResult | null {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^proxies\s*:\s*$/.test(line.trim()));
  if (start < 0) return null;
  const nodes: ParsedProxy[] = [];
  const warnings: string[] = [];
  let current: Record<string, unknown> | null = null;
  let rawLines: string[] = [];
  const flush = () => {
    if (!current) return;
    const node = nodeFromRecord(current, `yaml-${nodes.length + 1}`);
    if (node) {
      if (node.kernelOnly) node.config = rawLines.join('\n').trim();
      nodes.push(node);
    } else {
      warnings.push(`YAML 节点 ${String(current.name ?? '')} 无法识别`);
    }
    current = null;
    rawLines = [];
  };
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (!line.trim()) {
      if (current) rawLines.push('');
      continue;
    }
    if (/^\S/.test(line) && !line.startsWith('-')) break;
    const item = line.match(/^\s*-\s*(.*)$/);
    if (item) {
      flush();
      rawLines = [line];
      const rest = item[1]?.trim() ?? '';
      current = {};
      const pair = rest.match(/^([\w-]+)\s*:\s*(.*)$/);
      if (pair) current[pair[1]!] = unquote(pair[2] ?? '');
      continue;
    }
    if (current) rawLines.push(line);
    const pair = line.match(/^(\s+)([\w-]+)\s*:\s*(.*)$/);
    const indent = (line.match(/^(\s*)/)?.[1] ?? '').length;
    if (pair && current && indent <= 4) current[pair[2]!] = unquote(pair[3] ?? '');
  }
  flush();
  return { nodes, warnings };
}

function decodeBase64(text: string): string | null {
  const compact = text.replace(/\s+/g, '');
  if (compact.length < 16 || !/^[A-Za-z0-9+/=_-]+$/.test(compact)) return null;
  try {
    const normalized = compact.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = atob(normalized);
    return decoded.includes('://') || decoded.includes('\n') ? decoded : null;
  } catch {
    return null;
  }
}

export function parseProxyText(text: string): ParseResult {
  const trimmed = text.trim();
  if (!trimmed) return { nodes: [], warnings: ['内容为空'] };
  if (isSubscriptionUrl(trimmed)) {
    return { nodes: [], warnings: ['这是订阅链接，请用上方的“订阅地址”导入，让服务端拉取节点'] };
  }
  const json = parseJson(trimmed);
  if (json) return dedupe(json);
  const yaml = parseClashYaml(trimmed);
  if (yaml) return dedupe(yaml);
  const decoded = decodeBase64(trimmed);
  if (decoded) return parseProxyText(decoded);
  const nodes: ParsedProxy[] = [];
  const warnings: string[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const raw = line.trim();
    if (!raw || raw.startsWith('#')) continue;
    const node = parseProxyUri(raw) ?? parseClientLine(raw) ?? parseHostPortLine(raw);
    if (node) nodes.push(node);
    else warnings.push(`无法识别：${raw.slice(0, 60)}`);
  }
  return dedupe({ nodes, warnings });
}

export function proxyKey(node: Pick<ParsedProxy, 'protocol' | 'host' | 'port' | 'username'>): string {
  const family = node.protocol === 'http' || node.protocol === 'socks5' ? 'tcp-proxy' : node.protocol;
  return `${family}|${node.host.toLowerCase()}|${node.port}|${node.username}`;
}

function dedupe(result: ParseResult): ParseResult {
  const seen = new Set<string>();
  const nodes: ParsedProxy[] = [];
  for (const node of result.nodes) {
    const key = proxyKey(node);
    if (seen.has(key)) continue;
    seen.add(key);
    nodes.push(node);
  }
  return { nodes, warnings: result.warnings };
}
