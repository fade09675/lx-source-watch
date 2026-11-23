import { describe, expect, it } from 'vitest';
import { selectHops } from '../src/cn/proxyTest.js';
import { isUdpOnly, parseEgress, type RunnerProxy } from '../src/cn/proxyPool.js';

function proxy(over: Partial<RunnerProxy>): RunnerProxy {
  return {
    id: 'p',
    name: 'p',
    protocol: 'http',
    host: '1.1.1.1',
    port: 8080,
    username: '',
    password: '',
    kernelOnly: false,
    ...over,
  };
}

describe('isUdpOnly', () => {
  it('hy2/tuic 是 UDP，不可测', () => {
    expect(isUdpOnly({ protocol: 'hysteria2' })).toBe(true);
    expect(isUdpOnly({ protocol: 'tuic' })).toBe(true);
    expect(isUdpOnly({ protocol: 'socks5' })).toBe(false);
  });
});

describe('selectHops', () => {
  it('只取已测活的普通 http/socks5，按延迟升序，最多 5 个', () => {
    const list: RunnerProxy[] = [
      proxy({ id: 'a', protocol: 'http', host: 'a', lastOkAt: '2026-01-01', lastLatencyMs: 300 }),
      proxy({ id: 'b', protocol: 'socks5', host: 'b', lastOkAt: '2026-01-01', lastLatencyMs: 100 }),
      proxy({ id: 'c', protocol: 'http', host: 'c', lastOkAt: null, lastLatencyMs: 50 }),
      proxy({ id: 'd', protocol: 'http', host: 'd', lastOkAt: '2026-01-01', kernelOnly: true, lastLatencyMs: 60 }),
      proxy({ id: 'e', protocol: 'hysteria2', host: 'e', lastOkAt: '2026-01-01', lastLatencyMs: 70 }),
      proxy({ id: 'f', protocol: 'http', host: 'f', lastOkAt: '2026-01-01', lastLatencyMs: 200 }),
      proxy({ id: 'g', protocol: 'http', host: 'g', lastOkAt: '2026-01-01', lastLatencyMs: 400 }),
      proxy({ id: 'h', protocol: 'http', host: 'h', lastOkAt: '2026-01-01', lastLatencyMs: 500 }),
      proxy({ id: 'i', protocol: 'http', host: 'i', lastOkAt: '2026-01-01', lastLatencyMs: 600 }),
    ];
    const hops = selectHops(list, 5);
    expect(hops).toHaveLength(5);
    expect(hops.map((hop) => hop.host)).toEqual(['b', 'f', 'a', 'g', 'h']);
    expect(hops[0]).toMatchObject({ protocol: 'socks5', port: 8080 });
  });
});

describe('parseEgress', () => {
  it('解析 ipinfo JSON 的 ip/country/org ASN', () => {
    const parsed = parseEgress(true, JSON.stringify({ ip: '1.2.3.4', country: 'JP', org: 'AS2516 KDDI' }));
    expect(parsed).toEqual({ egressIp: '1.2.3.4', country: 'JP', asn: 'AS2516' });
  });

  it('解析 ipip 文本里的 IP 与 ASN', () => {
    expect(parseEgress(false, '当前 IP：1.2.3.4  来自：中国 上海 电信 AS4811')).toEqual({
      egressIp: '1.2.3.4',
      country: '',
      asn: 'AS4811',
    });
  });
});
