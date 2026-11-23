export interface PlatformMeta {
  key: string;
  name: string;
  /** 两字短名，用于紧凑矩阵。 */
  short: string;
  color: string;
  /** 是否属于 LX Music 官方平台。 */
  official: boolean;
  /** 是否有可用测试曲（决定能否真实检测）。 */
  testable: boolean;
}

/**
 * 注意 key 的含义：kw = 酷我（KuWo），kg = 酷狗（KuGou）。
 * 扩展平台来自第三方播放器/聚合脚本，LX 官方客户端不一定支持导入。
 */
export const PLATFORMS: PlatformMeta[] = [
  { key: 'kg', name: '酷狗音乐', short: '酷狗', color: '#f59e0b', official: true, testable: true },
  { key: 'kw', name: '酷我音乐', short: '酷我', color: '#3b82f6', official: true, testable: true },
  { key: 'tx', name: 'QQ 音乐', short: 'QQ', color: '#22c55e', official: true, testable: true },
  { key: 'wy', name: '网易云音乐', short: '网易云', color: '#ef4444', official: true, testable: true },
  { key: 'mg', name: '咪咕音乐', short: '咪咕', color: '#ec4899', official: true, testable: true },
  { key: 'qs', name: '汽水音乐', short: '汽水', color: '#eab308', official: false, testable: true },
  { key: 'bili', name: '哔哩哔哩', short: 'B站', color: '#fb7299', official: false, testable: false },
  { key: 'local', name: '本地文件', short: '本地', color: '#64748b', official: true, testable: false },
  { key: 'qsvip', name: 'QQ 音乐 SVIP', short: 'SVIP', color: '#06b6d4', official: false, testable: false },
  { key: 'ytb', name: 'YouTube', short: 'YT', color: '#dc2626', official: false, testable: false },
  { key: 'xm', name: '喜马拉雅', short: '喜马', color: '#f97316', official: false, testable: false },
  { key: 'joox', name: 'JOOX', short: 'JOOX', color: '#10b981', official: false, testable: false },
  { key: 'fanqie', name: '番茄畅听', short: '番茄', color: '#f43f5e', official: false, testable: false },
  { key: 'qimao', name: '七猫免费小说', short: '七猫', color: '#f59e0b', official: false, testable: false },
  { key: 'lrts', name: '懒人听书', short: '懒人', color: '#8b5cf6', official: false, testable: false },
  { key: 'tingyou', name: '听友', short: '听友', color: '#14b8a6', official: false, testable: false },
  { key: 'shuyinfm', name: '书音 FM', short: '书音', color: '#0ea5e9', official: false, testable: false },
  { key: 'cctv', name: '央视', short: '央视', color: '#b91c1c', official: false, testable: false },
  { key: 'baijia', name: '百家号', short: '百家', color: '#2563eb', official: false, testable: false },
  { key: 'xinwen', name: '新闻', short: '新闻', color: '#475569', official: false, testable: false },
];

const BY_KEY = new Map(PLATFORMS.map((p) => [p.key, p]));

export function platformMeta(key: string): PlatformMeta {
  return (
    BY_KEY.get(key) ?? {
      key,
      name: key,
      short: key.slice(0, 4),
      color: '#64748b',
      official: false,
      testable: false,
    }
  );
}

/** 展示顺序：官方平台在前，扩展平台按注册顺序。 */
export function platformRank(key: string): number {
  const i = PLATFORMS.findIndex((p) => p.key === key);
  return i === -1 ? 999 : i;
}

export function sortPlatformKeys(keys: string[]): string[] {
  return [...keys].sort((a, b) => platformRank(a) - platformRank(b));
}
