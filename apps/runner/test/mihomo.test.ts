import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { buildKernelConfig } from '../src/cn/mihomo.js';

interface Doc {
  'mixed-port'?: number;
  proxies: Array<Record<string, unknown>>;
  rules: string[];
  'proxy-groups': Array<Record<string, unknown>>;
}

function docOf(text: string): Doc {
  return parse(text) as Doc;
}

describe('buildKernelConfig', () => {
  it('把 sing-box JSON 节点转成 mihomo 配置', () => {
    const config = buildKernelConfig(
      [
        {
          id: 'a',
          name: '节点A',
          protocol: 'vmess',
          config: JSON.stringify({ type: 'vmess', server: '1.2.3.4', server_port: 443, uuid: 'u-1', security: 'auto' }),
        },
      ],
      7890,
    );
    const doc = docOf(config.yaml);
    expect(doc['mixed-port']).toBe(7890);
    expect(doc.proxies[0]).toMatchObject({ name: 'node-0', type: 'vmess', server: '1.2.3.4', port: 443, uuid: 'u-1' });
    expect(doc.rules).toEqual(['MATCH,PROXY']);
    expect(config.usable).toHaveLength(1);
  });

  it('解析 ss 分享链接', () => {
    const config = buildKernelConfig([
      {
        id: 'b',
        name: '节点B',
        protocol: 'ss',
        config: 'ss://YWVzLTI1Ni1nY206cGFzcw==@5.6.7.8:8388#%E9%A6%99%E6%B8%AF',
      },
    ]);
    const doc = docOf(config.yaml);
    expect(config.usable).toHaveLength(1);
    expect(doc.proxies[0]).toMatchObject({ type: 'ss', server: '5.6.7.8', port: 8388, cipher: 'aes-256-gcm' });
  });

  it('解析 Clash YAML 片段（IPTV 导出的 6 条内核配置就是这种格式）', () => {
    const config = buildKernelConfig([
      {
        id: 'c',
        name: '香港 SS',
        protocol: 'ss',
        config: '- name: 香港SS\n  type: ss\n  server: 9.9.9.9\n  port: 8388\n  cipher: aes-256-gcm\n  password: pass',
      },
      {
        id: 'd',
        name: '日本 VLESS',
        protocol: 'vless',
        config: '- name: 日本VLESS\n  type: vless\n  server: 8.8.8.8\n  port: 443\n  uuid: u-2\n  tls: true\n  servername: example.com\n  network: ws\n  ws-opts:\n    path: /ws',
      },
    ]);
    const doc = docOf(config.yaml);
    expect(config.usable).toHaveLength(2);
    expect(doc.proxies[0]).toMatchObject({ name: 'node-0', type: 'ss', server: '9.9.9.9', port: 8388, cipher: 'aes-256-gcm' });
    expect(doc.proxies[1]).toMatchObject({ name: 'node-1', type: 'vless', server: '8.8.8.8', port: 443, uuid: 'u-2' });
    expect(doc.rules).toEqual(['MATCH,PROXY']);
  });

  it('兼容子键缩进 4 格的 Clash YAML（IPTV 导出的实际格式）', () => {
    const config = buildKernelConfig([
      {
        id: 'g',
        name: '大陆直连回国',
        protocol: 'ss',
        config: '- name: "大陆直连回国"\n    type: ss\n    server: 7.7.7.7\n    port: 8388\n    cipher: aes-256-gcm\n    password: pass',
      },
    ]);
    expect(config.usable).toHaveLength(1);
    expect(docOf(config.yaml).proxies[0]).toMatchObject({ type: 'ss', server: '7.7.7.7', port: 8388 });
  });

  it('从 sing-box 的 outbounds 数组里跳过 selector，取真实节点', () => {
    const config = buildKernelConfig([
      {
        id: 'e',
        name: 'outbound',
        protocol: 'vmess',
        config: JSON.stringify({
          outbounds: [
            { type: 'selector', tag: 'select' },
            { type: 'vmess', server: '1.1.1.1', server_port: 443, uuid: 'u-3' },
          ],
        }),
      },
    ]);
    expect(config.usable).toHaveLength(1);
    expect(docOf(config.yaml).proxies[0]).toMatchObject({ type: 'vmess', server: '1.1.1.1', port: 443 });
  });

  it('内核节点可挂一个中转跳板（dialer-proxy）', () => {
    const config = buildKernelConfig(
      [{ id: 'h', name: '节点H', protocol: 'ss', config: 'ss://YWVzLTI1Ni1nY206cGFzcw==@5.6.7.8:8388#H' }],
      7890,
      { hop: { protocol: 'socks5', host: '10.0.0.1', port: 1080, username: 'u', password: 'p' } },
    );
    const doc = docOf(config.yaml);
    expect(doc.proxies[0]).toMatchObject({ name: 'hop', type: 'socks5', server: '10.0.0.1', port: 1080 });
    expect(doc.proxies[1]).toMatchObject({ name: 'node-0', 'dialer-proxy': 'hop' });
    expect(doc['proxy-groups'][0]?.proxies).toEqual(['node-0']);
  });

  it('无法解析的节点给出警告', () => {
    const config = buildKernelConfig([{ id: 'f', name: '坏节点', protocol: 'vmess', config: 'not-json' }]);
    expect(config.usable).toHaveLength(0);
    expect(config.warnings).toHaveLength(1);
    expect(docOf(config.yaml).rules).toEqual(['MATCH,DIRECT']);
  });
});
