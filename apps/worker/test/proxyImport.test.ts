import { describe, expect, it } from 'vitest';
import { isKernelProtocol, isSubscriptionUrl, parseProxyText, proxyKey } from '../src/proxyImport';

describe('parseProxyText', () => {
  it('解析 socks5 分享链接', () => {
    const result = parseProxyText('socks5://alice:secret@1.2.3.4:1080#%E4%B8%8A%E6%B5%B7');
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]).toMatchObject({
      protocol: 'socks5',
      host: '1.2.3.4',
      port: 1080,
      username: 'alice',
      password: 'secret',
      name: '上海',
      kernelOnly: false,
    });
  });

  it('把 ss 链接保留为内核节点', () => {
    const raw = 'ss://YWVzLTI1Ni1nY206cGFzcw==@1.2.3.4:8388#%E9%A6%99%E6%B8%AF';
    const result = parseProxyText(raw);
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]).toMatchObject({ protocol: 'ss', host: '1.2.3.4', port: 8388, kernelOnly: true });
    expect(result.nodes[0]?.config).toBe(raw);
  });

  it('解析 host:port:user:pass', () => {
    const result = parseProxyText('1.2.3.4:8080:bob:p%40ss');
    expect(result.nodes[0]).toMatchObject({ protocol: 'http', host: '1.2.3.4', port: 8080, username: 'bob', password: 'p%40ss' });
  });

  it('解析带名称的 host:port 行', () => {
    const result = parseProxyText('127.0.0.1:18080#local-test');
    expect(result.nodes[0]).toMatchObject({ host: '127.0.0.1', port: 18080, name: 'local-test' });
  });

  it('解析 Clash YAML 节点', () => {
    const yaml = ['proxies:', '  - name: HK', '    type: ss', '    server: 5.6.7.8', '    port: 8388', '    cipher: aes-256-gcm', '    password: pass'].join(
      '\n',
    );
    const result = parseProxyText(yaml);
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]).toMatchObject({ protocol: 'ss', host: '5.6.7.8', port: 8388, kernelOnly: true });
    expect(result.nodes[0]?.config).toContain('name: HK');
  });

  it('解析 sing-box JSON outbounds', () => {
    const json = JSON.stringify({
      outbounds: [{ type: 'vmess', tag: '节点A', server: '9.9.9.9', server_port: 443, uuid: 'u-1' }],
    });
    const result = parseProxyText(json);
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]).toMatchObject({ protocol: 'vmess', host: '9.9.9.9', port: 443 });
    expect(result.nodes[0]?.config).toContain('vmess');
  });

  it('解码 Base64 订阅', () => {
    const encoded = Buffer.from('http://1.2.3.4:8080\nsocks5://5.6.7.8:1080', 'utf8').toString('base64');
    const result = parseProxyText(encoded);
    expect(result.nodes.map((node) => node.host)).toEqual(['1.2.3.4', '5.6.7.8']);
  });

  it('同族节点去重', () => {
    const result = parseProxyText('1.2.3.4:8080\nhttp://1.2.3.4:8080');
    expect(result.nodes).toHaveLength(1);
  });

  it('识别内核协议', () => {
    expect(isKernelProtocol('vmess')).toBe(true);
    expect(isKernelProtocol('hysteria2')).toBe(true);
    expect(isKernelProtocol('http')).toBe(false);
    expect(proxyKey({ protocol: 'http', host: 'A.com', port: 80, username: '' })).toBe('tcp-proxy|a.com|80|');
  });

  it('订阅地址不会被当成节点', () => {
    const result = parseProxyText('https://sub.example.com/api/v1/client/subscribe?token=abc123');
    expect(result.nodes).toHaveLength(0);
    expect(result.warnings[0]).toContain('订阅');
  });

  it('区分订阅地址与 HTTP 代理地址', () => {
    expect(isSubscriptionUrl('https://sub.example.com/api/v1/client/subscribe?token=abc')).toBe(true);
    expect(isSubscriptionUrl('https://sub.example.com:8443/sub?token=abc')).toBe(true);
    expect(isSubscriptionUrl('http://1.2.3.4:8080')).toBe(false);
    expect(isSubscriptionUrl('http://1.2.3.4:8080/')).toBe(false);
    expect(isSubscriptionUrl('http://1.2.3.4')).toBe(true);
    const noPort = parseProxyText('http://1.2.3.4');
    expect(noPort.nodes).toHaveLength(0);
  });
});

describe('parseClientLine', () => {
  it('parses Surge/Loon line', () => {
    const result = parseProxyText('HK-01 = socks5, 5.6.7.8, 1080, alice, secret');
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]).toMatchObject({ protocol: 'socks5', host: '5.6.7.8', port: 1080, username: 'alice', password: 'secret' });
  });

  it('parses Quantumult X line', () => {
    const result = parseProxyText('socks5=9.9.9.9:1080, username=bob, password=pw, tag=SZ');
    expect(result.nodes[0]).toMatchObject({ protocol: 'socks5', host: '9.9.9.9', port: 1080, username: 'bob', password: 'pw', name: 'SZ' });
  });
});
