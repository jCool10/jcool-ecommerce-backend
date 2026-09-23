import type { ConfigService } from '@nestjs/config';
import type { ClsService } from 'nestjs-cls';
import { correlationHeaders } from '@jcool/platform/observability';
import type { CircuitBreakerFactory, OutboundCall } from '@jcool/platform/resilience';

export const USER_SERVICE_BREAKER = 'user-service';

// Only what the api reads: a field it would validate but never use could only fail a delivery.
export interface UserSummary {
  id: string;
  email: string;
}

/** The user-service answered, and not with what was asked for. */
export class UserServiceRejection extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    detail?: string,
  ) {
    super(`user-service ${path} answered ${status}${detail ? ` (${detail})` : ''}`);
    this.name = 'UserServiceRejection';
  }
}

/** A 4xx is about our request, not the service's health, so it never opens the circuit. */
export function isUserServiceFault(error: unknown): boolean {
  return !(error instanceof UserServiceRejection && error.status >= 400 && error.status < 500);
}

export interface UserServiceClientOptions {
  url: string;
  token: string;
  timeoutMs: number;
}

type Guard<T> = (body: unknown) => body is T;

const isSummary: Guard<UserSummary> = (body): body is UserSummary => {
  const { id, email } = (body ?? {}) as Record<string, unknown>;
  return typeof id === 'string' && typeof email === 'string';
};

const isEpoch: Guard<{ epoch: number }> = (body): body is { epoch: number } =>
  Number.isSafeInteger((body as { epoch?: unknown } | null)?.epoch);

/** No retry here: each caller owns its budget — a request can't wait, a queued job can. */
export class UserServiceClient {
  constructor(
    private readonly options: UserServiceClientOptions,
    private readonly breaker: OutboundCall,
    private readonly cls: ClsService,
  ) {}

  /** null when the user-service has no such user. */
  userSummary(userId: string): Promise<UserSummary | null> {
    return this.get(`/internal/v1/users/${encodeURIComponent(userId)}/summary`, isSummary);
  }

  /** null when the user-service has no such user. Answering also fills the Redis key. */
  async sessionEpoch(userId: string): Promise<number | null> {
    const body = await this.get(`/internal/v1/sessions/${encodeURIComponent(userId)}/epoch`, isEpoch);
    return body?.epoch ?? null;
  }

  private get<T>(path: string, isValid: Guard<T>): Promise<T | null> {
    return this.breaker.run(async () => {
      const response = await fetch(new URL(path, this.options.url), {
        headers: { authorization: `Bearer ${this.options.token}`, ...correlationHeaders(this.cls) },
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
      if (!response.ok) {
        // Unread, the body would hold its socket until GC.
        await response.body?.cancel();
        if (response.status === 404) return null;
        throw new UserServiceRejection(response.status, path);
      }

      const body: unknown = await response.json().catch(() => null);
      if (!isValid(body)) throw new UserServiceRejection(response.status, path, 'malformed body');
      return body;
    });
  }
}

/** One breaker name for every caller, so they share what they learn about an outage. */
export function createUserServiceClient(
  config: ConfigService,
  breakers: CircuitBreakerFactory,
  cls: ClsService,
): UserServiceClient {
  const timeoutMs = config.getOrThrow<number>('userService.timeoutMs');
  return new UserServiceClient(
    {
      url: config.getOrThrow<string>('userService.internalUrl'),
      token: config.getOrThrow<string>('userService.internalApiToken'),
      timeoutMs,
    },
    breakers.create(USER_SERVICE_BREAKER, { timeoutMs, isDownstreamFault: isUserServiceFault }),
    cls,
  );
}
