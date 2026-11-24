import { describe, expect, it } from 'vitest';
import { isPublicPath } from '../src/index.js';

describe('isPublicPath', () => {
  it('登录、上报、健康检查和静态资源不需要会话', () => {
    expect(isPublicPath('/login')).toBe(true);
    expect(isPublicPath('/api/auth/login')).toBe(true);
    expect(isPublicPath('/api/ingest')).toBe(true);
    expect(isPublicPath('/api/health')).toBe(true);
    expect(isPublicPath('/assets/index-abc.js')).toBe(true);
    expect(isPublicPath('/favicon.svg')).toBe(true);
  });

  it('runner 代理接口（含子路径）不需要会话，由 Bearer 自己校验', () => {
    expect(isPublicPath('/api/runner/proxies')).toBe(true);
    expect(isPublicPath('/api/runner/proxies/abc/check')).toBe(true);
  });

  it('页面和管理接口仍然需要会话', () => {
    expect(isPublicPath('/')).toBe(false);
    expect(isPublicPath('/admin/proxies')).toBe(false);
    expect(isPublicPath('/api/admin/proxies')).toBe(false);
    expect(isPublicPath('/api/status')).toBe(false);
  });
});
