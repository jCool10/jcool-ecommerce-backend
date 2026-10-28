import { type ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { CallerTokenGuard } from './caller-token.guard';
import { type CallerTokens, callerTokensFromEnv } from './caller-tokens.config';
import { InternalCallers } from './internal-callers.decorator';

const API = 'api-token-not-a-real-secret-0000000000000';
const API_PREVIOUS = 'api-previous-token-not-a-real-secret-00000';
const INVENTORY = 'inventory-token-not-a-real-secret-00000000';

class Routes {
  @InternalCallers('api')
  apiOnly(): void {}

  @InternalCallers('api', 'inventory-service')
  shared(): void {}

  undeclared(): void {}
}

interface FakeRequest {
  headers: { authorization?: string };
  internalCaller?: string;
}

function call(route: keyof Routes, authorization?: string) {
  const request: FakeRequest = { headers: authorization === undefined ? {} : { authorization } };
  const context = {
    getHandler: () => Reflect.get(Routes.prototype, route) as unknown,
    getClass: () => Routes,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { context, request };
}

const TOKENS: CallerTokens = { api: [API, API_PREVIOUS], 'inventory-service': [INVENTORY] };

const guard = (tokens: CallerTokens = TOKENS) =>
  new CallerTokenGuard(fakeConfigService({ 'internalApi.callers': tokens }), new Reflector());

function answer(route: keyof Routes, authorization?: string, tokens?: CallerTokens): unknown {
  try {
    return guard(tokens).canActivate(call(route, authorization).context);
  } catch (error) {
    return error;
  }
}

describe('CallerTokenGuard', () => {
  it('admits a caller on a route that lists it, and marks the request with who called', () => {
    const { context, request } = call('shared', `Bearer ${INVENTORY}`);

    expect(guard().canActivate(context)).toBe(true);
    expect(request.internalCaller).toBe('inventory-service');
  });

  it('admits the previous token while the caller rolls over to the new one', () => {
    expect(answer('apiOnly', `bearer ${API_PREVIOUS}`)).toBe(true);
  });

  it('refuses a known caller on a route that does not list it with 403', () => {
    expect(answer('apiOnly', `Bearer ${INVENTORY}`)).toBeInstanceOf(ForbiddenException);
  });

  it('refuses every caller on a route that declares no allowlist', () => {
    expect(answer('undeclared', `Bearer ${API}`)).toBeInstanceOf(ForbiddenException);
  });

  it('refuses a missing, foreign-scheme, wrong or truncated token with 401 before looking at the route', () => {
    for (const header of [undefined, 'Bearer ', `Basic ${API}`, 'Bearer not-a-token', `Bearer ${API.slice(0, -1)}`]) {
      expect(answer('undeclared', header), String(header)).toBeInstanceOf(UnauthorizedException);
    }
  });

  // The cause only reaches the rejected-request log line; the client sees the same body either way.
  it('tells a missing token from a wrong one in the cause, not in the response', () => {
    const missing = answer('apiOnly') as UnauthorizedException;
    const wrong = answer('apiOnly', 'Bearer not-a-token') as UnauthorizedException;

    expect(missing.getResponse()).toEqual(wrong.getResponse());
    expect((missing.cause as Error).message).not.toBe((wrong.cause as Error).message);
  });

  it('refuses to build without a single caller token, rather than admit everyone', () => {
    expect(() => guard({})).toThrow(/no internal caller token/);
    expect(() => guard({ api: [] })).toThrow(/no internal caller token/);
  });

  // One target sees every bearer sent to it, so a value shared by two callers lets one pass as the other.
  it('refuses to build when two callers share a token', () => {
    expect(() => guard({ api: [API], 'order-service': [INVENTORY, API] })).toThrow(
      /api.*order-service|order-service.*api/,
    );
  });
});

describe('callerTokensFromEnv', () => {
  it('reads each declared caller’s token and its previous one, skipping the unset', () => {
    const env = {
      INTERNAL_CALLER_TOKEN_API: API,
      INTERNAL_CALLER_TOKEN_API_PREVIOUS: '',
      INTERNAL_CALLER_TOKEN_ORDER_SERVICE: INVENTORY,
      INTERNAL_CALLER_TOKEN_ORDER_SERVICE_PREVIOUS: API_PREVIOUS,
      INTERNAL_CALLER_TOKEN_STRANGER: 'not-declared-so-never-accepted-000000000',
    };

    expect(callerTokensFromEnv(['api', 'order-service', 'payment-service'], env)).toEqual({
      api: [API],
      'order-service': [INVENTORY, API_PREVIOUS],
      'payment-service': [],
    });
  });
});
