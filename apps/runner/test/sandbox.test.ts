import { describe, expect, it } from 'vitest';
import { loadLxSource } from '../src/lx/sandbox.js';

const GOOD_SOURCE = `
const lx = globalThis.lx
lx.on(lx.EVENT_NAMES.request, ({ source, action }) => {
  if (action !== 'musicUrl') return Promise.reject(new Error('仅支持 musicUrl'))
  if (source === 'kg') return Promise.resolve('https://example.com/kg.mp3')
  return Promise.resolve({ url: 'https://example.com/tx.mp3' })
})
lx.send(lx.EVENT_NAMES.inited, {
  status: true,
  sources: {
    kg: { name: '酷狗', type: 'music', actions: ['musicUrl'], qualitys: ['128k', '320k'] },
    tx: { name: 'QQ音乐', type: 'music', actions: ['musicUrl'], qualitys: ['128k'] },
  },
})
`;

describe('loadLxSource', () => {
  it('初始化后能读到平台声明', async () => {
    const loaded = await loadLxSource({ code: GOOD_SOURCE, filename: 'good.js' });
    try {
      expect(Object.keys(loaded.sources).sort()).toEqual(['kg', 'tx']);
      expect(loaded.sources.kg?.qualitys).toContain('320k');
      expect(loaded.meta.name).toBe('good');
    } finally {
      loaded.dispose();
    }
  });

  it('call 能拿到字符串地址或 { url } 对象', async () => {
    const loaded = await loadLxSource({ code: GOOD_SOURCE, filename: 'good.js' });
    try {
      const kg = await loaded.call({
        source: 'kg',
        action: 'musicUrl',
        info: { type: 'song', musicInfo: {} },
      });
      expect(kg).toBe('https://example.com/kg.mp3');

      const tx = await loaded.call({
        source: 'tx',
        action: 'musicUrl',
        info: { type: 'song', musicInfo: {} },
      });
      expect(tx).toBe('https://example.com/tx.mp3');
    } finally {
      loaded.dispose();
    }
  });

  it('初始化失败时抛出可读错误', async () => {
    const code = `
      const lx = globalThis.lx
      lx.send(lx.EVENT_NAMES.inited, { status: false, errorMessage: '当前版本已停止服务' })
    `;
    await expect(loadLxSource({ code, filename: 'bad.js' })).rejects.toThrow(/已停止服务/);
  });

  it('没有声明任何平台时抛出明确错误', async () => {
    const code = `
      const lx = globalThis.lx
      lx.send(lx.EVENT_NAMES.inited, { status: true, sources: {} })
    `;
    await expect(loadLxSource({ code, filename: 'empty.js' })).rejects.toThrow(/未声明任何平台/);
  });

  it('支持 console.group 等浏览器方法', async () => {
    const code = `
      const lx = globalThis.lx
      console.group('init')
      console.info('starting')
      console.table([{ a: 1 }])
      console.groupEnd()
      lx.on(lx.EVENT_NAMES.request, () => Promise.resolve('https://example.com/a.mp3'))
      lx.send(lx.EVENT_NAMES.inited, {
        status: true,
        sources: { kg: { name: '酷狗', actions: ['musicUrl'], qualitys: ['128k'] } },
      })
    `;
    const loaded = await loadLxSource({ code, filename: 'console.js' });
    try {
      expect(loaded.sources.kg).toBeTruthy();
    } finally {
      loaded.dispose();
    }
  });

  it('aesEncrypt 支持 ECB 与不足 16 字节的 IV', async () => {
    const code = `
      const lx = globalThis.lx
      lx.on(lx.EVENT_NAMES.request, ({ source }) => {
        const key = lx.utils.buffer.from('0123456789abcdef')
        if (source === 'ecb') return Promise.resolve(lx.utils.crypto.aesEncrypt('hello', 'aes-128-ecb', key).toString('hex'))
        return Promise.resolve(lx.utils.crypto.aesEncrypt('hello', 'aes-128-cbc', key, 'short').toString('hex'))
      })
      lx.send(lx.EVENT_NAMES.inited, {
        status: true,
        sources: {
          ecb: { name: 'ECB', actions: ['musicUrl'], qualitys: ['128k'] },
          cbc: { name: 'CBC', actions: ['musicUrl'], qualitys: ['128k'] },
        },
      })
    `;
    const loaded = await loadLxSource({ code, filename: 'crypto.js' });
    try {
      const ecb = await loaded.call({
        source: 'ecb',
        action: 'musicUrl',
        info: { type: 'song', musicInfo: {} },
      });
      const cbc = await loaded.call({
        source: 'cbc',
        action: 'musicUrl',
        info: { type: 'song', musicInfo: {} },
      });
      expect(typeof ecb).toBe('string');
      expect(String(ecb)).toMatch(/^[0-9a-f]+$/);
      expect(typeof cbc).toBe('string');
      expect(String(cbc)).toMatch(/^[0-9a-f]+$/);
    } finally {
      loaded.dispose();
    }
  });

  it('超时的脚本不会永久挂起', async () => {
    const code = `while (true) {}`;
    await expect(
      loadLxSource({ code, filename: 'loop.js', initTimeoutMs: 300, scriptTimeoutMs: 300 }),
    ).rejects.toThrow();
  }, 10_000);
});
