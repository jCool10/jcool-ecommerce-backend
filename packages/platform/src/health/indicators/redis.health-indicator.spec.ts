import { HealthIndicatorService } from '@nestjs/terminus';
import { describe, expect, it, vi } from 'vitest';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import type { RedisService } from '../../redis';
import { RedisHealthIndicator } from './redis.health-indicator';

function build(replies: Array<() => Promise<string>>) {
  const error = vi.fn();
  const info = vi.fn();
  const ping = () => (replies.shift() ?? (() => Promise.resolve('PONG')))();
  const indicator = new RedisHealthIndicator(
    new HealthIndicatorService(),
    { ping } as unknown as RedisService,
    fakePinoLogger({ error, info }),
  );
  const probe = async (times: number): Promise<string[]> => {
    const statuses: string[] = [];
    for (let i = 0; i < times; i++) statuses.push((await indicator.isHealthy('redis')).redis.status);
    return statuses;
  };
  return { probe, error, info };
}

const refused = () => Promise.reject(new Error('connection refused'));

describe('RedisHealthIndicator', () => {
  // Readiness is polled every few seconds, so a line per probe would bury the outage it reports.
  it('reports each probe but logs only the transitions', async () => {
    const { probe, error, info } = build([refused, refused]);

    await expect(probe(4)).resolves.toEqual(['down', 'down', 'up', 'up']);
    expect(error).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledTimes(1);
  });

  it('reports down on a reply other than PONG', async () => {
    const wrong = () => Promise.resolve('LOADING');
    const { probe, error } = build([wrong, wrong]);

    await expect(probe(2)).resolves.toEqual(['down', 'down']);
    expect(error).toHaveBeenCalledTimes(1);
  });
});
