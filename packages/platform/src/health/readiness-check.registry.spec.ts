import { HealthIndicatorService } from '@nestjs/terminus';
import { describe, expect, it } from 'vitest';
import { RegisteredHealthIndicator } from './indicators/registered.health-indicator';
import { ReadinessCheckRegistry, type ReadinessCheck } from './readiness-check.registry';

const check = (name: string, isReady: ReadinessCheck['isReady']): ReadinessCheck => ({ name, isReady });

describe('ReadinessCheckRegistry', () => {
  it('lists every registered check once, even when one registers twice', () => {
    const registry = new ReadinessCheckRegistry();
    const temporal = check('temporal', () => Promise.resolve(true));

    registry.register(temporal);
    registry.register(temporal);
    registry.register(check('search', () => Promise.resolve(true)));

    expect(registry.all().map(({ name }) => name)).toEqual(['temporal', 'search']);
  });

  it('refuses a second check under a name already taken', () => {
    const registry = new ReadinessCheckRegistry();
    registry.register(check('temporal', () => Promise.resolve(true)));

    expect(() => registry.register(check('temporal', () => Promise.resolve(false)))).toThrow(/temporal/);
  });
});

describe('RegisteredHealthIndicator', () => {
  const indicator = new RegisteredHealthIndicator(new HealthIndicatorService());

  it.each([
    ['ready', () => Promise.resolve(true), 'up'],
    ['not ready', () => Promise.resolve(false), 'down'],
    ['failing', () => Promise.reject(new Error('unreachable')), 'down'],
  ] as const)('reports a %s check as %s under its own name', async (_label, isReady, status) => {
    const result = await indicator.isHealthy(check('temporal', isReady));

    expect(result.temporal.status).toBe(status);
  });
});
