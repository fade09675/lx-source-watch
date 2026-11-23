import { describe, expect, it } from 'vitest';
import {
  LOGIN_MAX_FAILURES,
  SESSION_COOKIE,
  buildClearSessionCookie,
  buildSessionCookie,
  clearLoginFailures,
  createSessionToken,
  hashPassword,
  loginAllowed,
  noteLoginFailure,
  parsePasswordHash,
  readCookie,
  verifyPassword,
  verifySessionToken,
} from '../src/auth';

class FakeKV {
  readonly store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

describe('密码哈希', () => {
  it('哈希后能验证正确密码，拒绝错误密码', async () => {
    const stored = await hashPassword('87065121', 10_000);
    expect(stored.startsWith('pbkdf2$sha256$10000$')).toBe(true);
    expect(await verifyPassword('87065121', stored)).toBe(true);
    expect(await verifyPassword('87065122', stored)).toBe(false);
  });

  it('非法哈希格式返回 null 并验证失败', async () => {
    expect(parsePasswordHash('plain-text')).toBeNull();
    expect(parsePasswordHash('pbkdf2$md5$210000$aa$bb')).toBeNull();
    expect(await verifyPassword('x', 'plain-text')).toBe(false);
  });
});

describe('会话 token', () => {
  const secret = 'test-secret';

  it('签发后可验证，篡改后失败', async () => {
    const token = await createSessionToken(secret, 3600);
    expect(await verifySessionToken(secret, token)).toBe(true);
    expect(await verifySessionToken(secret, `${token}x`)).toBe(false);
    expect(await verifySessionToken('other-secret', token)).toBe(false);
  });

  it('过期 token 验证失败', async () => {
    const token = await createSessionToken(secret, -10);
    expect(await verifySessionToken(secret, token)).toBe(false);
  });
});

describe('Cookie 与登录限流', () => {
  it('读取 Cookie 并能生成/清除会话 Cookie', () => {
    const token = 'abc.def';
    expect(readCookie(`a=1; ${SESSION_COOKIE}=${token}; b=2`, SESSION_COOKIE)).toBe(token);
    expect(readCookie('a=1', SESSION_COOKIE)).toBeUndefined();
    expect(buildSessionCookie(token, false)).toContain('HttpOnly');
    expect(buildSessionCookie(token, false)).not.toContain('Secure');
    expect(buildSessionCookie(token, true)).toContain('Secure');
    expect(buildClearSessionCookie(false)).toContain('Max-Age=0');
  });

  it('连续失败达到上限后锁定，清空后恢复', async () => {
    const kv = new FakeKV() as unknown as KVNamespace;
    expect(await loginAllowed(kv, '1.2.3.4')).toBe(true);
    for (let index = 0; index < LOGIN_MAX_FAILURES; index += 1) {
      await noteLoginFailure(kv, '1.2.3.4');
    }
    expect(await loginAllowed(kv, '1.2.3.4')).toBe(false);
    expect(await loginAllowed(kv, '5.6.7.8')).toBe(true);
    await clearLoginFailures(kv, '1.2.3.4');
    expect(await loginAllowed(kv, '1.2.3.4')).toBe(true);
  });
});
