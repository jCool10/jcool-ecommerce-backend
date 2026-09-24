import { BeforeApplicationShutdown, Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PinoLogger } from 'nestjs-pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { TelemetryFlushService, type TelemetryFlushGlobal } from './telemetry-flush.service';

const telemetryGlobal = globalThis as TelemetryFlushGlobal;

afterEach(() => {
  delete telemetryGlobal.__flushTelemetry;
});

describe('TelemetryFlushService', () => {
  it('flushes only after the drain window closes, and shutdown waits for it', async () => {
    const order: string[] = [];
    // Resolves on a later tick on purpose: a fire-and-forget hook would let close() return between
    // the two pushes, which is the whole difference between an exported span and a dropped one.
    telemetryGlobal.__flushTelemetry = async () => {
      order.push('flush-start');
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push('flush-done');
      return 'flushed';
    };

    // Stands in for ShutdownService, which holds the readiness grace period open while requests
    // (and therefore spans and Sentry events) are still being produced.
    @Injectable()
    class DrainStub implements BeforeApplicationShutdown {
      async beforeApplicationShutdown(): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push('drained');
      }
    }

    const moduleRef = await Test.createTestingModule({
      providers: [TelemetryFlushService, DrainStub, { provide: PinoLogger, useValue: fakePinoLogger() }],
    }).compile();
    await moduleRef.close();

    expect(order).toEqual(['drained', 'flush-start', 'flush-done']);
  });

  it('logs a completed flush at info and a flush cut short by its ceiling at warn', async () => {
    const levelFor = async (outcome: 'flushed' | 'timed_out'): Promise<string[]> => {
      telemetryGlobal.__flushTelemetry = () => Promise.resolve(outcome);
      const info = vi.fn();
      const warn = vi.fn();
      await new TelemetryFlushService(fakePinoLogger({ info, warn })).onApplicationShutdown();
      return [...info.mock.calls.map(() => 'info'), ...warn.mock.calls.map(() => 'warn')];
    };

    expect([await levelFor('flushed'), await levelFor('timed_out')]).toEqual([['info'], ['warn']]);
  });
});
