import { ServiceUnavailableException } from '@nestjs/common';
import { HealthIndicatorService, TerminusModule } from '@nestjs/terminus';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { HealthController } from './health.controller';
import { DrizzleHealthIndicator, RedisHealthIndicator, ShutdownHealthIndicator } from './indicators';
import { ReadinessCheckRegistry } from './readiness-check.registry';

type Probe = (name: string) => void;

async function build(register: (registry: ReadinessCheckRegistry, probe: Probe) => void = () => undefined) {
  const order: string[] = [];
  const probe: Probe = (name) => order.push(name);
  const indicators = new HealthIndicatorService();
  const builtIn = (name: string) => ({
    isHealthy: (key: string) => {
      probe(name);
      return Promise.resolve(indicators.check(key).up());
    },
  });

  const moduleRef = await Test.createTestingModule({
    imports: [TerminusModule.forRoot({ logger: false })],
    controllers: [HealthController],
    providers: [
      ReadinessCheckRegistry,
      { provide: ShutdownHealthIndicator, useValue: builtIn('shutdown') },
      { provide: DrizzleHealthIndicator, useValue: builtIn('database') },
      { provide: RedisHealthIndicator, useValue: builtIn('redis') },
    ],
  }).compile();
  register(moduleRef.get(ReadinessCheckRegistry), probe);
  return { controller: moduleRef.get(HealthController), order };
}

describe('HealthController', () => {
  it('checks exactly shutdown, database and redis when nothing registered', async () => {
    const { controller, order } = await build();

    const result = await controller.ready();

    expect(order).toEqual(['shutdown', 'database', 'redis']);
    expect(Object.keys(result.details)).toEqual(['shutdown', 'database', 'redis']);
  });

  it('runs the registered checks after the built-in three', async () => {
    const { controller, order } = await build((registry, probe) => {
      registry.register({ name: 'temporal', check: () => Promise.resolve(probe('temporal')) });
    });

    const result = await controller.ready();

    expect(order).toEqual(['shutdown', 'database', 'redis', 'temporal']);
    expect(result.details.temporal).toEqual({ status: 'up' });
  });

  it('reports down, with the reason, when a registered check fails', async () => {
    const { controller } = await build((registry) => {
      registry.register({ name: 'temporal', check: () => Promise.reject(new Error('temporal unreachable')) });
    });

    const failure = await controller.ready().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ServiceUnavailableException);
    expect((failure as ServiceUnavailableException).getResponse()).toMatchObject({
      status: 'error',
      error: { temporal: { status: 'down', message: 'temporal unreachable' } },
    });
  });

  it('never runs a registered check on liveness', async () => {
    const { controller, order } = await build((registry, probe) => {
      registry.register({ name: 'temporal', check: () => Promise.resolve(probe('temporal')) });
    });

    await controller.live();

    expect(order).toEqual([]);
  });
});
