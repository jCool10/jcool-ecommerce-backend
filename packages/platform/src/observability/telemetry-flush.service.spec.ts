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
  it('flushes after the drain window closes, and shutdown waits for the flush to finish', async () => {
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

  it('is a no-op when the app was started without the instrumentation preload', async () => {
    const info = vi.fn();
    await expect(new TelemetryFlushService(fakePinoLogger({ info })).onApplicationShutdown()).resolves.toBeUndefined();
    expect(info).not.toHaveBeenCalled();
  });

  it('logs the flush duration once it completes', async () => {
    telemetryGlobal.__flushTelemetry = () => Promise.resolve('flushed');
    const info = vi.fn();

    await new TelemetryFlushService(fakePinoLogger({ info })).onApplicationShutdown();

    expect(info).toHaveBeenCalledWith({ seconds: expect.any(Number) as number }, 'telemetry flushed on shutdown');
  });

  it('warns rather than claiming a flush when the ceiling cut it short', async () => {
    telemetryGlobal.__flushTelemetry = () => Promise.resolve('timed_out');
    const info = vi.fn();
    const warn = vi.fn();

    await new TelemetryFlushService(fakePinoLogger({ info, warn })).onApplicationShutdown();

    expect(info).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      { seconds: expect.any(Number) as number },
      'telemetry flush hit its ceiling on shutdown — drain-window spans and errors may be lost',
    );
  });
});
