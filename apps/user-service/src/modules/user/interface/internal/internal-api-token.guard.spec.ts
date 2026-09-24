import { type ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { InternalApiTokenGuard } from './internal-api-token.guard';

const CURRENT = 'current-internal-token-not-a-real-secret-0000';
const PREVIOUS = 'previous-internal-token-not-a-real-secret-000';

function requestWith(authorization?: string): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers: authorization === undefined ? {} : { authorization } }) }),
  } as unknown as ExecutionContext;
}

const guard = (tokens: string[]): InternalApiTokenGuard =>
  new InternalApiTokenGuard(fakeConfigService({ 'internalApi.tokens': tokens }));

function answerTo(tokens: string[], authorization?: string): unknown {
  try {
    return guard(tokens).canActivate(requestWith(authorization));
  } catch (error) {
    return error;
  }
}

describe('InternalApiTokenGuard', () => {
  it('admits the current token and, during a rotation, the previous one', () => {
    expect([
      answerTo([CURRENT, PREVIOUS], `Bearer ${CURRENT}`),
      answerTo([CURRENT, PREVIOUS], `bearer ${PREVIOUS}`),
    ]).toEqual([true, true]);
  });

  it('refuses a missing, empty, foreign-scheme, wrong or truncated token with 401', () => {
    const headers: Record<string, string | undefined> = {
      'no header': undefined,
      'an empty bearer': 'Bearer ',
      'another scheme': `Basic ${CURRENT}`,
      'a wrong token': 'Bearer not-the-token',
      'a prefix of the token': `Bearer ${CURRENT.slice(0, -1)}`,
    };

    const refusals = Object.entries(headers).map(([name, header]) => [
      name,
      answerTo([CURRENT], header) instanceof UnauthorizedException,
    ]);

    expect(Object.fromEntries(refusals)).toEqual(Object.fromEntries(Object.keys(headers).map((n) => [n, true])));
  });

  // The cause only reaches the rejected-request log line; the client sees the same body either way.
  it('tells a missing token from a wrong one in the cause, not in the response', () => {
    const missing = answerTo([CURRENT]) as UnauthorizedException;
    const wrong = answerTo([CURRENT], 'Bearer not-the-token') as UnauthorizedException;

    expect(missing.getResponse()).toEqual(wrong.getResponse());
    expect((missing.cause as Error).message).not.toBe((wrong.cause as Error).message);
  });

  it('refuses to build without an accepted token, rather than admit everyone', () => {
    expect(() => guard([])).toThrow(/INTERNAL_API_TOKEN/);
  });
});
