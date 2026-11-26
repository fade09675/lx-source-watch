import type { SourceResult } from './schema.js';

export type SourceQualityTier = 'excellent' | 'good' | 'limited' | 'poor' | 'untested';

export interface SourceQuality {
  score: number;
  tier: SourceQualityTier;
  recommended: boolean;
  reasons: string[];
  platformRate: number;
  endpointRate: number;
}

export const QUALITY_META: Record<SourceQualityTier, { label: string; tone: 'ok' | 'warn' | 'bad' | 'idle' }> = {
  excellent: { label: '很好', tone: 'ok' },
  good: { label: '良好', tone: 'ok' },
  limited: { label: '一般', tone: 'warn' },
  poor: { label: '较差', tone: 'bad' },
  untested: { label: '未测', tone: 'idle' },
};

const HOUR = 60 * 60 * 1000;
const FRESH_WINDOW = 26 * HOUR;

function ratio(ok: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(1, ok / total));
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function assessSourceQuality(source: SourceResult, now = Date.now()): SourceQuality {
  const declared = source.platforms.filter((item) => item.declared);
  const tested = declared.filter((item) => item.tested);
  const ok = tested.filter((item) => item.ok);

  const endpoints = source.endpoints;
  const endpointOk = endpoints.filter((item) => item.ok).length;

  const platformRate = ratio(ok.length, tested.length);
  const endpointRate = ratio(endpointOk, endpoints.length);
  const coverage = ratio(tested.length, declared.length);

  const checkedAt = Date.parse(source.checkedAt);
  const fresh = Number.isFinite(checkedAt) && now - checkedAt <= FRESH_WINDOW;

  const cnTested = declared.filter((item) => item.cn?.tested);
  const cnOk = cnTested.filter((item) => item.cn?.ok);
  const cnRate = cnTested.length > 0 ? ratio(cnOk.length, cnTested.length) : null;

  let score = 0;
  score += platformRate * 50;
  score += endpointRate * 20;
  score += coverage * 10;
  score += fresh ? 10 : 0;
  score += cnRate === null ? 5 : cnRate * 5;
  if (!source.initOk) score -= 30;
  score = Math.max(0, Math.min(100, Math.round(score)));

  const reasons: string[] = [];
  if (!source.initOk) reasons.push('脚本初始化失败');
  if (tested.length === 0) reasons.push('还没有平台测试结果');
  else reasons.push(`平台通过 ${ok.length}/${tested.length}（${percent(platformRate)}）`);
  if (endpoints.length > 0) reasons.push(`接入点 ${endpointOk}/${endpoints.length}`);
  if (!fresh) reasons.push('最近结果已过期');
  if (cnRate !== null) reasons.push(`国内可达 ${cnOk.length}/${cnTested.length}`);

  let tier: SourceQualityTier;
  if (!source.initOk) tier = 'poor';
  else if (source.status === 'untested' || tested.length === 0) tier = 'untested';
  else if (!fresh) tier = 'limited';
  else if (cnRate === 0) tier = 'limited';
  else if (source.status === 'available' && endpointRate >= 0.8) tier = 'excellent';
  else if (platformRate >= 0.6 && endpointRate >= 0.6 && tested.length >= 2) tier = 'good';
  else if (platformRate >= 0.3) tier = 'limited';
  else tier = 'poor';

  return {
    score,
    tier,
    recommended: tier === 'excellent' || tier === 'good',
    reasons,
    platformRate,
    endpointRate,
  };
}
