/**
 * 各平台的最小可用测试曲。
 * 字段沿用 LX 自定义源 musicInfo 的常用键；脚本一般只读其中的 id/hash/songmid。
 * 这些是公开歌曲的 ID，用于触发脚本的取链逻辑，不涉及音频内容分发。
 */
export interface TestCase {
  id: string;
  label: string;
  musicInfo: Record<string, unknown>;
}

export const TEST_SONGS: Record<string, TestCase[]> = {
  kg: [
    {
      id: 'kg-1',
      label: '酷狗候选 1',
      musicInfo: {
        hash: 'C41E80A18D1448FA47086372999C7F43',
        songmid: '3261014',
        name: '测试曲',
        singer: '测试',
      },
    },
    {
      id: 'kg-2',
      label: '酷狗候选 2',
      musicInfo: {
        hash: 'E5C40A31C3C16BA461F650035734C123',
        songmid: '27359949',
        name: '测试曲',
        singer: '测试',
      },
    },
  ],
  kw: [
    {
      id: 'kw-1',
      label: '酷我候选 1',
      musicInfo: {
        musicrid: 'MUSIC_321946135',
        rid: '321946135',
        songmid: '321946135',
        hash: 'MUSIC_321946135',
        name: '测试曲',
        singer: '测试',
      },
    },
  ],
  tx: [
    {
      id: 'tx-1',
      label: 'QQ 候选 1',
      musicInfo: {
        songmid: '001yS0N33yPm1B',
        strMediaMid: '002MX8Ea4e5RDS',
        mediaMid: '002MX8Ea4e5RDS',
        name: '测试曲',
        singer: '测试',
      },
    },
    {
      id: 'tx-2',
      label: 'QQ 候选 2',
      musicInfo: {
        songmid: '002rZjwv4ddzKt',
        strMediaMid: '002thQK83lEc2Q',
        mediaMid: '002thQK83lEc2Q',
        name: '测试曲',
        singer: '测试',
      },
    },
  ],
  wy: [
    {
      id: 'wy-1',
      label: '网易云候选 1',
      musicInfo: {
        id: '1357375695',
        songmid: '1357375695',
        name: '测试曲',
        singer: '测试',
        albumName: '测试专辑',
      },
    },
    {
      id: 'wy-2',
      label: '网易云候选 2',
      musicInfo: {
        id: '347230',
        name: '测试曲',
        singer: '测试',
        albumName: '测试专辑',
      },
    },
  ],
  mg: [
    {
      id: 'mg-jay',
      label: '咪咕候选 0',
      musicInfo: {
        copyrightId: '60054704965',
        songId: '600929000000096577',
        contentId: '600929000000096577',
        songmid: '600929000000096577',
        albumId: '1133556323',
        name: '测试曲',
        singer: '测试',
      },
    },
    {
      id: 'mg-1',
      label: '咪咕候选 1',
      musicInfo: {
        copyrightId: '600913000009337537',
        songId: '6005752DXKE',
        contentId: '6005752DXKE',
        songmid: '6005752DXKE',
        albumId: '1133556323',
        name: '测试曲',
        singer: '测试',
      },
    },
    {
      id: 'mg-2',
      label: '咪咕候选 2',
      musicInfo: {
        copyrightId: '600913000009337537',
        songmid: '1135162566',
        albumId: '1133556323',
        name: '测试曲',
        singer: '测试',
      },
    },
  ],
  qs: [
    {
      id: 'qs-1',
      label: '汽水候选 1',
      musicInfo: {
        id: '6705003948140398594',
        name: '测试曲',
        singer: '测试',
      },
    },
    {
      id: 'qs-2',
      label: '汽水候选 2',
      musicInfo: {
        id: '7676337516358617115',
        name: '测试曲',
        singer: '测试',
      },
    },
  ],
};

export function testCasesFor(platform: string): TestCase[] {
  return TEST_SONGS[platform] ?? [];
}

export function isTestablePlatform(platform: string): boolean {
  return (TEST_SONGS[platform]?.length ?? 0) > 0;
}

export const TESTABLE_PLATFORMS = Object.keys(TEST_SONGS);
