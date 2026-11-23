import { QUALITY_PRIORITY, type Quality } from '@lx/shared';

const VALID = new Set<string>(QUALITY_PRIORITY);

export function isQuality(value: string): value is Quality {
  return VALID.has(value);
}

export function declaredQualities(qualitys: string[]): Quality[] {
  return qualitys.filter(isQuality);
}

/**
 * 决定本轮要尝试的音质顺序。
 * 默认只测 128k；--quality 指定时优先该音质，失败回退 128k；--deep 从最高音质开始。
 */
export function qualityChain(
  qualitys: string[],
  requested: Quality | 'auto' | undefined,
  deep: boolean,
): Quality[] {
  const declared = declaredQualities(qualitys);
  if (requested && requested !== 'auto' && isQuality(requested)) {
    return dedupe([requested, '128k']);
  }
  if (deep) {
    const highest = [...declared].sort(
      (a, b) => QUALITY_PRIORITY.indexOf(b) - QUALITY_PRIORITY.indexOf(a),
    )[0];
    if (highest) return dedupe([highest, '128k']);
  }
  if (declared.includes('128k')) return ['128k'];
  if (declared[0]) return dedupe([declared[0], '128k']);
  return ['128k'];
}

function dedupe(items: Quality[]): Quality[] {
  return [...new Set(items)];
}
