import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hasValidSignature, signValue } from './kafka-message-signature';

const KEY = 'k'.repeat(32);
const OTHER_KEY = 'o'.repeat(32);
const value = Buffer.from(JSON.stringify({ outboxId: '1', eventType: 'order.placed' }));

describe('kafka message signature', () => {
  it('is the hex HMAC-SHA256 of exactly the value bytes', () => {
    expect(signValue(KEY, value)).toBe(createHmac('sha256', KEY).update(value).digest('hex'));
    expect(signValue(KEY, value)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('accepts the signature the producer put on the same bytes', () => {
    expect(hasValidSignature(KEY, value, Buffer.from(signValue(KEY, value)))).toBe(true);
  });

  it('refuses a missing header', () => {
    expect(hasValidSignature(KEY, value, undefined)).toBe(false);
  });

  it('refuses a header that is not 64 hex characters, without throwing', () => {
    const signature = signValue(KEY, value);
    for (const header of ['', signature.slice(0, 63), `${signature}0`, signature.replace(/^./, 'z'), 'not hex']) {
      expect(hasValidSignature(KEY, value, Buffer.from(header)), JSON.stringify(header)).toBe(false);
    }
  });

  it('refuses a signature made with another key', () => {
    expect(hasValidSignature(KEY, value, Buffer.from(signValue(OTHER_KEY, value)))).toBe(false);
  });

  it('refuses a value changed by one byte after signing', () => {
    const signature = Buffer.from(signValue(KEY, value));
    const tampered = Buffer.from(value);
    tampered[tampered.length - 2] ^= 0x01;

    expect(hasValidSignature(KEY, tampered, signature)).toBe(false);
  });
});
