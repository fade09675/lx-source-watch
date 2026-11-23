import { describe, expect, it } from 'vitest';
import { signBody, verifySignature } from '../src/hmac';

const SECRET = 'test-secret';
const BODY = JSON.stringify({ runId: 'abc123', sources: [] });
const NOW = Date.parse('2026-11-23T10:00:00.000Z');

function timestamp(offsetMs = 0): string {
  return new Date(NOW + offsetMs).toISOString();
}

describe('hmac', () => {
  it('接受正确签名', async () => {
    const signature = await signBody(BODY, SECRET);
    const result = await verifySignature({ body: BODY, secret: SECRET, signature, timestamp: timestamp(), now: NOW });
    expect(result).toEqual({ ok: true });
  });

  it('拒绝被篡改的正文', async () => {
    const signature = await signBody(BODY, SECRET);
    const result = await verifySignature({
      body: `${BODY} `,
      secret: SECRET,
      signature,
      timestamp: timestamp(),
      now: NOW,
    });
    expect(result).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('拒绝过期时间戳', async () => {
    const signature = await signBody(BODY, SECRET);
    const result = await verifySignature({
      body: BODY,
      secret: SECRET,
      signature,
      timestamp: timestamp(-11 * 60_000),
      now: NOW,
    });
    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it('拒绝缺失签名与时间戳', async () => {
    expect(await verifySignature({ body: BODY, secret: SECRET, signature: null, timestamp: timestamp(), now: NOW })).toEqual({
      ok: false,
      reason: 'missing-signature',
    });
    const signature = await signBody(BODY, SECRET);
    expect(await verifySignature({ body: BODY, secret: SECRET, signature, timestamp: null, now: NOW })).toEqual({
      ok: false,
      reason: 'missing-timestamp',
    });
  });

  it('拒绝非法时间戳与非法 hex', async () => {
    const signature = await signBody(BODY, SECRET);
    expect(
      await verifySignature({ body: BODY, secret: SECRET, signature, timestamp: 'not-a-date', now: NOW }),
    ).toEqual({ ok: false, reason: 'bad-timestamp' });
    expect(
      await verifySignature({ body: BODY, secret: SECRET, signature: 'zzzz', timestamp: timestamp(), now: NOW }),
    ).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('未配置 secret 时拒绝', async () => {
    const result = await verifySignature({ body: BODY, secret: '', signature: 'aa', timestamp: timestamp(), now: NOW });
    expect(result).toEqual({ ok: false, reason: 'no-secret' });
  });
});
