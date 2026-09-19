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

describe('InternalApiTokenGuard', () => {
  it('admits the current token', () => {
    expect(guard([CURRENT, PREVIOUS]).canActivate(requestWith(`Bearer ${CURRENT}`))).toBe(true);
  });

  it('admits the previous token while a rotation is under way', () => {
    expect(guard([CURRENT, PREVIOUS]).canActivate(requestWith(`bearer ${PREVIOUS}`))).toBe(true);
  });

  it.each([
    ['no header', undefined],
    ['an empty bearer', 'Bearer '],
    ['another scheme', `Basic ${CURRENT}`],
    ['a wrong token', 'Bearer not-the-token'],
    ['a prefix of the token', `Bearer ${CURRENT.slice(0, -1)}`],
  ])('refuses %s', (_case, header) => {
    expect(() => guard([CURRENT]).canActivate(requestWith(header))).toThrow(UnauthorizedException);
  });

  it('refuses to build without a token, rather than admit everyone', () => {
    expect(() => guard([])).toThrow(/INTERNAL_API_TOKEN/);
  });
});
