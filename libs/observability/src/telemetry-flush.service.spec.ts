import { BeforeApplicationShutdown, Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { TelemetryFlushService, type TelemetryFlushGlobal } from './telemetry-flush.service';

const telemetryGlobal = globalThis as TelemetryFlushGlobal;

afterEach(() => {
  delete telemetryGlobal.__flushTelemetry;
});

// The handle this service calls is published by an app's `instrumentation.ts` preload, which no
// library may reach — the flush budget and the Sentry/OTLP race it protects are proved next to that
// file, in apps/commerce-core/src/instrumentation.spec.ts. What is left here is the contract this
// side owns: WHEN the handle is called relative to the drain, and what happens without one.
describe('TelemetryFlushService', () => {
  it('flushes after the drain window closes, and shutdown waits for the flush to finish', async () => {
    const order: string[] = [];
    // Resolves on a later tick on purpose: a fire-and-forget hook would let close() return between
    // the two pushes, which is the whole difference between an exported span and a dropped one.
    telemetryGlobal.__flushTelemetry = async (): Promise<void> => {
      order.push('flush-start');
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push('flush-done');
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

    const moduleRef = await Test.createTestingModule({ providers: [TelemetryFlushService, DrainStub] }).compile();
    await moduleRef.close();

    expect(order).toEqual(['drained', 'flush-start', 'flush-done']);
  });

  it('is a no-op when the app was started without the instrumentation preload', async () => {
    await expect(new TelemetryFlushService().onApplicationShutdown()).resolves.toBeUndefined();
  });
});
