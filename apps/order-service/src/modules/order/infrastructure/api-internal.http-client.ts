import type { ConfigService } from '@nestjs/config';
import type { ClsService } from 'nestjs-cls';
import type { PinoLogger } from 'nestjs-pino';
import { correlationHeaders } from '@jcool/platform/observability';
import type { CircuitBreakerFactory, OutboundCall } from '@jcool/platform/resilience';
import { CheckoutReadUnavailableError } from '../application/checkout-unavailable.error';

export const API_INTERNAL_BREAKER = 'api-internal';

// Above the read deadline, so a slow read ends on its abort signal rather than the breaker.
const BREAKER_HEADROOM_MS = 1_000;

const LOG_CONTEXT = 'ApiInternalClient';

export interface ApiServiceOptions {
  url: string;
  token: string;
  timeoutMs: number;
}

/** The api answered, but not with what the contract names. */
export class ApiInternalRejection extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
  ) {
    super(`api-internal ${path} answered ${status} off its contract`);
    this.name = 'ApiInternalRejection';
  }
}

/** Only a 5xx or no answer says the api is unwell; a 4xx or a body off the contract is our misconfiguration. */
export function isApiInternalFault(error: unknown): boolean {
  return !(error instanceof ApiInternalRejection) || error.status >= 500;
}

// A 429 is load, not configuration; the rest of 4xx and every bad shape here is a wrong URL or token.
function isMisconfiguration(error: unknown): error is ApiInternalRejection {
  return error instanceof ApiInternalRejection && error.status !== 429 && error.status < 500;
}

function unparsedAsNull(error: unknown): null {
  if (error instanceof SyntaxError) return null;
  throw error;
}

/**
 * The api's internal read routes, read before tx A. Every failure is a CheckoutReadUnavailableError, so
 * the checkout answers 503 + Retry-After and writes nothing; nothing here retries.
 */
export class ApiInternalClient {
  constructor(
    private readonly options: ApiServiceOptions,
    private readonly breaker: OutboundCall,
    private readonly cls: ClsService,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(LOG_CONTEXT);
  }

  async read<T>(path: string, body: unknown, accept: (status: number, body: unknown) => T | undefined): Promise<T> {
    try {
      return await this.breaker.run(() => this.call(path, body, accept));
    } catch (error) {
      if (isMisconfiguration(error)) {
        this.logger.error({ path, status: error.status, err: error }, 'api-internal answered off its contract');
      }
      throw new CheckoutReadUnavailableError(`api-internal ${path}`, { cause: error });
    }
  }

  private async call<T>(path: string, body: unknown, accept: (status: number, body: unknown) => T | undefined) {
    const response = await fetch(new URL(path, this.options.url), {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${this.options.token}`,
        ...(body !== undefined && { 'content-type': 'application/json' }),
        ...correlationHeaders(this.cls),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.options.timeoutMs),
    });
    const answer = accept(response.status, await response.json().catch(unparsedAsNull));
    if (answer === undefined) throw new ApiInternalRejection(response.status, path);
    return answer;
  }
}

export function createApiInternalClient(
  config: ConfigService,
  breakers: CircuitBreakerFactory,
  cls: ClsService,
  logger: PinoLogger,
): ApiInternalClient {
  const timeoutMs = config.getOrThrow<number>('apiService.timeoutMs');
  return new ApiInternalClient(
    {
      url: config.getOrThrow<string>('apiService.url'),
      token: config.getOrThrow<string>('apiService.token'),
      timeoutMs,
    },
    breakers.create(API_INTERNAL_BREAKER, {
      timeoutMs: timeoutMs + BREAKER_HEADROOM_MS,
      isDownstreamFault: isApiInternalFault,
    }),
    cls,
    logger,
  );
}
