import { formatMs, platformMeta, platformTone, type PlatformResult } from '@lx/shared';

export function PlatformChip({ platform }: { platform: PlatformResult }) {
  const meta = platformMeta(platform.key);
  const tone = platformTone(platform.tested, platform.ok);
  const label = platform.tested ? (platform.ok ? formatMs(platform.totalMs) : '失败') : '未测';
  const title = [
    meta.name,
    platform.tested ? (platform.ok ? '通过' : '失败') : '未测试',
    platform.quality ? `音质 ${platform.quality}` : '',
    platform.error ?? '',
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <span className={`platform-chip tone-${tone}`} title={title}>
      <span className="platform-name">{meta.short}</span>
      <span className="platform-value">{label}</span>
    </span>
  );
}
