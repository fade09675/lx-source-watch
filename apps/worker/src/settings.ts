import type { D1Database } from '@cloudflare/workers-types';
import { getSetting, touchSetting } from './db';

/** 设置统一存在 settings 表的这一个键下。 */
export const APP_SETTINGS_KEY = 'app.settings';

export interface AppSettings {
  /** 探测总开关。 */
  probeEnabled: boolean;
  /** 探测间隔（小时）。 */
  probeIntervalHours: number;
  /** 每轮最多测几个源，0 表示全部。 */
  probeLimit: number;
  /** 单轮源并发。 */
  probeConcurrency: number;
  /** 从脚本声明的最高音质开始。 */
  probeDeep: boolean;
  /** 优先使用加速镜像下载脚本。 */
  preferMirror: boolean;
  /** 国内补测开关。 */
  cnEnabled: boolean;
  /** 国内补测最多尝试几个代理。 */
  cnMaxProxies: number;
  /** 国内补测并发。 */
  cnConcurrency: number;
  /** 内核节点最多试几个跳板。 */
  cnMaxHops: number;
  /** 国内补测失败后是否自动换下一个代理。 */
  cnAutoSwitch: boolean;
  /** 订阅拉取默认 User-Agent；留空用内置 UA。 */
  proxyFetchUserAgent: string;
  /** 代理测活开关。 */
  proxyTestEnabled: boolean;
  /** 代理测活间隔（小时）。 */
  proxyTestIntervalHours: number;
  /** 代理测活并发。 */
  proxyTestConcurrency: number;
  /** 单个代理测活超时（毫秒）。 */
  proxyTestTimeoutMs: number;
  /** 自动发现候选开关。 */
  discoveryEnabled: boolean;
  /** 自动发现间隔（小时）。 */
  discoveryIntervalHours: number;
  /** 候选通过初始化后自动收录进正式清单。 */
  autoPromoteCandidates: boolean;
  /** 每轮最多自动收录几个。 */
  autoPromoteMaxPerRun: number;
  /** 运行明细保留天数。 */
  retentionDetailDays: number;
  /** 日汇总保留天数。 */
  retentionDailyDays: number;
  /** 事件保留天数。 */
  retentionEventDays: number;
  updatedAt?: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  probeEnabled: true,
  probeIntervalHours: 4,
  probeLimit: 0,
  probeConcurrency: 2,
  probeDeep: false,
  preferMirror: true,
  cnEnabled: true,
  cnMaxProxies: 8,
  cnConcurrency: 5,
  cnMaxHops: 5,
  cnAutoSwitch: true,
  proxyFetchUserAgent: '',
  proxyTestEnabled: true,
  proxyTestIntervalHours: 6,
  proxyTestConcurrency: 5,
  proxyTestTimeoutMs: 20_000,
  discoveryEnabled: true,
  discoveryIntervalHours: 12,
  autoPromoteCandidates: true,
  autoPromoteMaxPerRun: 3,
  retentionDetailDays: 14,
  retentionDailyDays: 180,
  retentionEventDays: 180,
};

type Raw = Record<string, unknown>;

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function int(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function text(value: unknown, fallback: string, maxLength: number): string {
  if (typeof value !== 'string') return fallback;
  return value.trim().slice(0, maxLength);
}

/** 把任意输入收紧成一份完整设置；缺省或非法字段回落到默认值。 */
export function normalizeSettings(input: unknown): AppSettings {
  const raw: Raw = input && typeof input === 'object' ? (input as Raw) : {};
  const d = DEFAULT_SETTINGS;
  return {
    probeEnabled: bool(raw.probeEnabled, d.probeEnabled),
    probeIntervalHours: int(raw.probeIntervalHours, d.probeIntervalHours, 1, 24),
    probeLimit: int(raw.probeLimit, d.probeLimit, 0, 999),
    probeConcurrency: int(raw.probeConcurrency, d.probeConcurrency, 1, 8),
    probeDeep: bool(raw.probeDeep, d.probeDeep),
    preferMirror: bool(raw.preferMirror, d.preferMirror),
    cnEnabled: bool(raw.cnEnabled, d.cnEnabled),
    cnMaxProxies: int(raw.cnMaxProxies, d.cnMaxProxies, 1, 20),
    cnConcurrency: int(raw.cnConcurrency, d.cnConcurrency, 1, 10),
    cnMaxHops: int(raw.cnMaxHops, d.cnMaxHops, 1, 5),
    cnAutoSwitch: bool(raw.cnAutoSwitch, d.cnAutoSwitch),
    proxyFetchUserAgent: text(raw.proxyFetchUserAgent, d.proxyFetchUserAgent, 200),
    proxyTestEnabled: bool(raw.proxyTestEnabled, d.proxyTestEnabled),
    proxyTestIntervalHours: int(raw.proxyTestIntervalHours, d.proxyTestIntervalHours, 1, 72),
    proxyTestConcurrency: int(raw.proxyTestConcurrency, d.proxyTestConcurrency, 1, 10),
    proxyTestTimeoutMs: int(raw.proxyTestTimeoutMs, d.proxyTestTimeoutMs, 5_000, 90_000),
    discoveryEnabled: bool(raw.discoveryEnabled, d.discoveryEnabled),
    discoveryIntervalHours: int(raw.discoveryIntervalHours, d.discoveryIntervalHours, 1, 168),
    autoPromoteCandidates: bool(raw.autoPromoteCandidates, d.autoPromoteCandidates),
    autoPromoteMaxPerRun: int(raw.autoPromoteMaxPerRun, d.autoPromoteMaxPerRun, 1, 10),
    retentionDetailDays: int(raw.retentionDetailDays, d.retentionDetailDays, 3, 60),
    retentionDailyDays: int(raw.retentionDailyDays, d.retentionDailyDays, 30, 365),
    retentionEventDays: int(raw.retentionEventDays, d.retentionEventDays, 7, 365),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : undefined,
  };
}

/** 读取设置；数据库里没有或损坏时返回默认值。 */
export async function loadSettings(db: D1Database): Promise<AppSettings> {
  const raw = await getSetting(db, APP_SETTINGS_KEY);
  if (!raw) return normalizeSettings({});
  try {
    return normalizeSettings(JSON.parse(raw));
  } catch {
    return normalizeSettings({});
  }
}

/** 合并保存（只传需要改的字段即可），返回保存后的完整设置。 */
export async function saveSettings(
  db: D1Database,
  patch: unknown,
  now = new Date().toISOString(),
): Promise<AppSettings> {
  const current = await loadSettings(db);
  const merged = normalizeSettings({ ...current, ...(patch && typeof patch === 'object' ? patch : {}) });
  merged.updatedAt = now;
  await touchSetting(db, APP_SETTINGS_KEY, JSON.stringify(merged), now);
  return merged;
}

/** 恢复默认设置。 */
export async function resetSettings(db: D1Database, now = new Date().toISOString()): Promise<AppSettings> {
  const value = normalizeSettings({});
  value.updatedAt = now;
  await touchSetting(db, APP_SETTINGS_KEY, JSON.stringify(value), now);
  return value;
}
