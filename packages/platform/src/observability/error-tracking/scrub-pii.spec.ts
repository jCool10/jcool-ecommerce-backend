import type { ErrorEvent, EventHint } from '@sentry/nestjs';
import { describe, expect, it } from 'vitest';
import { scrubPii } from './scrub-pii';

const HINT = {} as EventHint;
const event = (partial: Partial<ErrorEvent>): ErrorEvent => partial as ErrorEvent;

describe('scrubPii', () => {
  it('redacts credentials in the request body, including a nested one', () => {
    const out = scrubPii(
      event({ request: { data: { token: 'secret-token', user: { password: 'p@ss', name: 'ok' } } } }),
      HINT,
    );

    const data = out.request?.data as { token: string; user: { password: string; name: string } };
    expect(data.token).toBe('[Redacted]');
    expect(data.user.password).toBe('[Redacted]');
    expect(data.user.name).toBe('ok');
  });

  it('redacts the authorization and cookie request headers', () => {
    const out = scrubPii(
      event({ request: { headers: { authorization: 'Bearer abc', cookie: 'sid=xyz', accept: 'json' } } }),
      HINT,
    );

    const headers = out.request?.headers as Record<string, string>;
    expect(headers.authorization).toBe('[Redacted]');
    expect(headers.cookie).toBe('[Redacted]');
    expect(headers.accept).toBe('json');
  });

  it('drops the raw query string and strips the url query (external sink gets no query PII)', () => {
    const out = scrubPii(
      event({ request: { url: 'https://api.example.com/search?token=abc&q=hi', query_string: 'token=abc&q=hi' } }),
      HINT,
    );

    expect(out.request?.query_string).toBeUndefined();
    expect(out.request?.url).toBe('https://api.example.com/search');
  });

  it('drops the customer email from event.user (external sink gets no PII)', () => {
    const out = scrubPii(event({ user: { id: 'u1', email: 'a@b.com' } }), HINT);

    expect(out.user?.email).toBeUndefined();
    // The id stays: an error still has to be attributable to an account.
    expect(out.user?.id).toBe('u1');
  });

  it('tolerates a string request body and a missing request (no throw)', () => {
    expect(() => scrubPii(event({ request: { data: 'raw-body-string' } }), HINT)).not.toThrow();
    expect(() => scrubPii(event({}), HINT)).not.toThrow();
  });

  it('returns the same event instance (mutated in place, as beforeSend expects)', () => {
    const input = event({ extra: { password: 'x' } });
    const out = scrubPii(input, HINT);
    expect(out).toBe(input);
    expect((out.extra as { password: string }).password).toBe('[Redacted]');
  });
});
