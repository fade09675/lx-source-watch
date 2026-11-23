/**
 * 错误分类。runner 负责把底层异常映射到这些枚举，前端只做展示。
 * resolve = 向平台取播放地址；stream = 拿到地址后实际拉流校验。
 */
export const ERROR_KINDS = [
  'init',
  'script',
  'resolve_http',
  'resolve_network',
  'resolve_timeout',
  'resolve_empty',
  'stream_http',
  'stream_non_audio',
  'stream_network',
  'stream_timeout',
  'unsupported',
  'untested',
] as const;

export type ErrorKind = (typeof ERROR_KINDS)[number];

export const ERROR_LABEL: Record<ErrorKind, string> = {
  init: '初始化失败',
  script: '脚本异常',
  resolve_http: '取链失败（上游 HTTP）',
  resolve_network: '取链网络失败',
  resolve_timeout: '取链超时',
  resolve_empty: '未返回播放地址',
  stream_http: '拉流失败（HTTP）',
  stream_non_audio: '拉流返回非音频',
  stream_network: '拉流网络失败',
  stream_timeout: '拉流超时',
  unsupported: '平台未支持',
  untested: '未测试',
};

export type ErrorGroup = 'init' | 'resolve' | 'stream' | 'unsupported' | 'untested';

export function errorGroup(kind: ErrorKind | undefined): ErrorGroup {
  if (!kind) return 'untested';
  if (kind === 'init') return 'init';
  // script 是取链阶段脚本抛错，归入 resolve 组，和“取链失败”一起展示。
  if (kind === 'script') return 'resolve';
  if (kind.startsWith('resolve_')) return 'resolve';
  if (kind.startsWith('stream_')) return 'stream';
  if (kind === 'untested') return 'untested';
  return 'unsupported';
}

/** 给用户的下一步建议，展示在错误详情里。 */
export const ERROR_HINT: Partial<Record<ErrorKind, string>> = {
  init: '脚本加载或 inited 事件失败，通常是脚本过期、接口变更或被风控。',
  script: '脚本执行抛错，可展开原始错误定位。',
  resolve_http: '平台接口返回 4xx/5xx，可能是参数失效、地区限制或需要登录。',
  resolve_network: '连接被拒绝、DNS 失败或 TLS 错误，常见于接口域名失效。',
  resolve_timeout: '20 秒内未取到播放地址，可能是多线路回退过慢。',
  resolve_empty: '脚本返回了空地址或非 http(s) 地址。',
  stream_http: '拿到了地址但 CDN 返回 4xx/5xx，可能是签名过期、地区封锁或防盗链。',
  stream_non_audio: '返回的是 HTML/JSON 等非音频内容，通常是错误页或需要鉴权。',
  stream_network: '拉流连接失败，域名可能只对特定网络开放。',
  stream_timeout: '12 秒内未读到音频数据，CDN 可能限速或不可达。',
  unsupported: '该平台不在当前脚本的测试范围，或属于播放器扩展平台。',
  untested: '缺少该平台的测试曲，或本轮被跳过。',
};
