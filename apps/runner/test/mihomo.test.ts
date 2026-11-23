import { describe, expect, it } from 'vitest';
import { buildKernelConfig } from '../src/cn/mihomo.js';

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
    expect(config.yaml).toContain('mixed-port: 7890');
    expect(config.yaml).toContain('type: "vmess"');
    expect(config.yaml).toContain('MATCH,node-0');
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
    expect(config.usable).toHaveLength(1);
    expect(config.yaml).toContain('type: "ss"');
    expect(config.yaml).toContain('cipher: "aes-256-gcm"');
  });

  it('无法解析的节点给出警告', () => {
    const config = buildKernelConfig([{ id: 'c', name: '坏节点', protocol: 'vmess', config: 'not-json' }]);
    expect(config.usable).toHaveLength(0);
    expect(config.warnings).toHaveLength(1);
    expect(config.yaml).toContain('MATCH,DIRECT');
  });
});
