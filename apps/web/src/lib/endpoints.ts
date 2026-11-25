type RecommendableEndpoint = {
  url: string;
  role: 'primary' | 'candidate';
  ok: boolean;
  versionState?: 'synced' | 'lagging' | 'unknown' | null;
  ms?: number | null;
};

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function pickRecommended(
  endpoints: RecommendableEndpoint[],
  fallback: string,
): { url: string; kind: string } {
  const primary = endpoints.find((item) => item.role === 'primary');
  const mirrors = endpoints.filter((item) => item.role === 'candidate');
  const candidates = [primary, ...mirrors].filter((item): item is RecommendableEndpoint => Boolean(item?.ok));
  const score = (item: RecommendableEndpoint): number => {
    const synced = item.versionState === 'synced';
    if (item.role === 'primary') return synced ? 0 : 3;
    return synced ? 1 : 2;
  };
  candidates.sort((a, b) => {
    const byScore = score(a) - score(b);
    if (byScore !== 0) return byScore;
    return (a.ms ?? Number.POSITIVE_INFINITY) - (b.ms ?? Number.POSITIVE_INFINITY);
  });
  const best = candidates[0];
  if (best) {
    return {
      url: best.url,
      kind:
        best.role === 'primary'
          ? best.versionState === 'synced'
            ? '主地址'
            : '主地址（版本落后）'
          : `镜像 ${hostOf(best.url)}`,
    };
  }
  if (primary) return { url: primary.url, kind: '主地址（当前不可用）' };
  return { url: fallback, kind: '源地址' };
}
