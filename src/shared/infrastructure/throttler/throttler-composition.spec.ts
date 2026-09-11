import {
  Controller,
  Post,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { Throttle, ThrottlerModule, type ThrottlerStorage } from '@nestjs/throttler';
import type { Server } from 'node:http';
import { PinoLogger } from 'nestjs-pino';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { METRICS, type MetricsPort } from '@shared/observability/metrics/metrics.port';
import { AccountAwareThrottlerGuard } from './account-aware-throttler.guard';
import {
  ACCOUNT_THROTTLER,
  DEFAULT_THROTTLER,
  GLOBAL_THROTTLERS,
  ORDER_THROTTLE,
  USER_THROTTLER,
} from './throttler.constants';
import { UserThrottlerGuard } from './user-throttler.guard';

/**
 * The split of tiers between the two guards only exists once a real Nest app resolves the global
 * guard and a route-level one against the same options, so no unit test can see it. This boots that
 * app with the storage faked and asserts which tiers reach it, at which limits, exactly once each.
 */

const USER_ID = 'u-1';

// Stands in for JwtAuthGuard: the per-user tier exists to be keyed by what this attaches, and
// global guards run before route-level ones, which is the ordering under test.
class FakeAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    context.switchToHttp().getRequest<{ user?: unknown }>().user = { userId: USER_ID };
    return true;
  }
}

@Controller('orders')
class ProbeController {
  @Post()
  @Throttle(ORDER_THROTTLE)
  @UseGuards(UserThrottlerGuard)
  create(): { ok: boolean } {
    return { ok: true };
  }

  // No route guard: the user tier must stay unenforced here rather than fall back to the IP.
  @Post('unguarded')
  unguarded(): { ok: boolean } {
    return { ok: true };
  }
}

async function boot(overLimit = false) {
  const increment = vi.fn<ThrottlerStorage['increment']>().mockResolvedValue({
    totalHits: 1,
    timeToExpire: 60,
    isBlocked: overLimit,
    timeToBlockExpire: overLimit ? 60 : 0,
  });
  const recordRateLimitRejection = vi.fn<MetricsPort['recordRateLimitRejection']>();
  const moduleRef = await Test.createTestingModule({
    imports: [ThrottlerModule.forRoot({ throttlers: GLOBAL_THROTTLERS, storage: { increment } })],
    controllers: [ProbeController],
    providers: [
      { provide: METRICS, useValue: { recordRateLimitRejection } },
      { provide: PinoLogger, useValue: { warn: vi.fn() } },
      { provide: APP_GUARD, useClass: AccountAwareThrottlerGuard },
      { provide: APP_GUARD, useClass: FakeAuthGuard },
    ],
  }).compile();
  const app = await moduleRef.createNestApplication().init();
  return { app, increment, recordRateLimitRejection };
}

// `getHttpServer()` is untyped; supertest needs the concrete server.
const http = (app: INestApplication) => request(app.getHttpServer() as Server);

// The tier and limit of every call that reached the storage, in order.
// `increment(key, ttl, limit, blockDuration, throttlerName)`.
function tiersCharged(increment: ReturnType<typeof vi.fn>): Array<[string, number]> {
  return increment.mock.calls.map((call) => [String(call[4]), Number(call[2])]);
}

describe('throttler composition', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('charges each tier exactly once on a guarded route, at its per-route limit', async () => {
    const booted = await boot();
    app = booted.app;

    await http(app).post('/orders').expect(201);

    // Not a superset check: a duplicate `user` entry here is the double-counting bug the split
    // between the two guards exists to prevent.
    expect(tiersCharged(booted.increment)).toEqual([
      [DEFAULT_THROTTLER, ORDER_THROTTLE[DEFAULT_THROTTLER].limit],
      [ACCOUNT_THROTTLER, GLOBAL_THROTTLERS[1].limit],
      [USER_THROTTLER, ORDER_THROTTLE[USER_THROTTLER].limit],
    ]);
  });

  it('leaves the user tier unenforced on a route that does not mount the guard', async () => {
    const booted = await boot();
    app = booted.app;

    await http(app).post('/orders/unguarded').expect(201);

    expect(tiersCharged(booted.increment).map(([tier]) => tier)).toEqual([DEFAULT_THROTTLER, ACCOUNT_THROTTLER]);
  });

  it('answers 429 and counts the rejection against the tier and route template', async () => {
    const booted = await boot(true);
    app = booted.app;

    await http(app).post('/orders').expect(429);

    expect(booted.recordRateLimitRejection).toHaveBeenCalledWith(DEFAULT_THROTTLER, '/orders');
  });
});
