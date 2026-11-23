/** 快照 schema 版本，结构不兼容时递增。 */
export const SCHEMA_VERSION = 1 as const;

/** 计划检测间隔（小时）。GitHub cron 实际触发会有延迟。 */
export const INTERVAL_HOURS = 4;

/** 音质优先级：从最宽松到最高。默认只测 128k。 */
export const QUALITY_PRIORITY = [
  '128k',
  '320k',
  '192k',
  'flac',
  'flac24bit',
  'hires',
  'atmos',
  'master',
] as const;

export type Quality = (typeof QUALITY_PRIORITY)[number];

export const QUALITY_LABEL: Record<string, string> = {
  '128k': '标准 128k',
  '320k': '高品 320k',
  '192k': '192k',
  flac: '无损 FLAC',
  flac24bit: 'Hi-Res 24bit',
  hires: 'Hi-Res',
  atmos: '全景声',
  master: '母带',
};

/** LX 官方支持的平台 key。 */
export const OFFICIAL_PLATFORM_KEYS = ['kg', 'kw', 'tx', 'wy', 'mg', 'local'] as const;

/** 明细数据保留天数。 */
export const DETAIL_RETENTION_DAYS = 14;

/** 日汇总保留天数。 */
export const DAILY_RETENTION_DAYS = 180;

/** 连续失败多少轮标记为“持续失效”。 */
export const PERSISTENT_FAILURE_ROUNDS = 3;
