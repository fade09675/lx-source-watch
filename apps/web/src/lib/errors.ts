const HTTP_LABELS: Record<number, string> = {
  400: '请求格式错误',
  401: '需要登录',
  403: '拒绝访问',
  404: '地址不存在',
  405: '请求方式不被允许',
  408: '请求超时',
  410: '地址已失效',
  429: '请求过于频繁',
  500: '服务器内部错误',
  502: '上游网关错误',
  503: '服务暂不可用',
  504: '上游响应超时',
  521: '源站未响应',
  522: '源站连接超时',
  523: '源站不可达',
  524: '源站响应超时',
  525: 'TLS 握手失败',
  526: 'TLS 证书无效',
};

const RULES: Array<[RegExp, string]> = [
  [/ECONNRESET|connection reset|read ECONNRESET/i, '连接被重置'],
  [/ETIMEDOUT|ESOCKETTIMEDOUT|请求超时|timed? ?out/i, '请求超时'],
  [/ECONNREFUSED|connection refused/i, '连接被拒绝'],
  [/ENOTFOUND|getaddrinfo ENOTFOUND|getaddrinfo ENOENT|DNS name does not exist/i, '域名解析失败'],
  [/EAI_AGAIN|getaddrinfo EAI_AGAIN/i, 'DNS 暂时不可用'],
  [/EHOSTUNREACH|ENETUNREACH|network is unreachable/i, '网络不可达'],
  [/EPROTO|write EPROTO|ssl.*wrong version|tls.*handshake/i, 'TLS 握手失败'],
  [/certificate|self[- ]signed|unable to verify/i, 'TLS 证书校验失败'],
  [/socket hang up/i, '连接被对方关闭'],
  [/strict-origin|cross-origin|CORS/i, '跨域请求被拒绝'],
  [/Unexpected token|not valid JSON|JSON\.parse|is not valid JSON/i, '返回内容不是合法 JSON'],
  [/failed to fetch|fetch failed/i, '网络请求失败'],
  [/aborted|AbortError/i, '请求被中断'],
  [/unknown error/i, '未知错误'],
];

export function humanizeError(raw: string | null | undefined, fallback = '未知错误'): string {
  const text = (raw ?? '').trim();
  if (!text) return fallback;

  if (/所有(?:后端|线路|音源)均失败/.test(text) && /getaddrinfo|ENOENT|ENOTFOUND/i.test(text)) {
    return '所有线路均失败（域名解析失败）';
  }

  const http = text.match(/\b(?:HTTP\s*|status\s*)?([45]\d\d)\b/i);
  if (http) {
    const code = Number(http[1]);
    const label = HTTP_LABELS[code] ?? (code >= 500 ? '服务器错误' : '请求失败');
    return `${label}（HTTP ${code}）`;
  }

  for (const [pattern, label] of RULES) {
    if (pattern.test(text)) return label;
  }

  if (/^\d{12,}$/.test(text) || /^[0-9A-F]{12,}$/i.test(text)) {
    return `未知错误（${text.slice(0, 12)}…）`;
  }

  const oneLine = text.replace(/\s+/g, ' ');
  return oneLine.length > 120 ? `${oneLine.slice(0, 118)}…` : oneLine;
}
