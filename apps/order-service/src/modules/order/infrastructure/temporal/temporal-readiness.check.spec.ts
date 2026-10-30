import type { ConfigService } from '@nestjs/config';
import type { Connection } from '@temporalio/client';
import { ReadinessCheckRegistry } from '@jcool/platform/health';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import type { CheckoutSagaWorker, CheckoutSagaWorkerState } from './checkout-saga.worker';
import { TemporalReadinessCheck } from './temporal-readiness.check';

const NOW = new Date('2026-10-29T10:00:00.000Z');

describe('TemporalReadinessCheck', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const build = ({
    workerEnabled = true,
    state = 'RUNNING',
  }: { workerEnabled?: boolean; state?: CheckoutSagaWorkerState } = {}) => {
    const getSystemInfo = vi.fn().mockResolvedValue({});
    const withDeadline = vi.fn((_deadline: number, call: () => Promise<unknown>) => call());
    const connection = { withDeadline, workflowService: { getSystemInfo } } as unknown as Connection;
    const worker = { status: vi.fn(() => ({ state })) };
    const config = { getOrThrow: () => ({ temporal: { workerEnabled } }) } as unknown as ConfigService;
    const registry = new ReadinessCheckRegistry();
    const warn = vi.fn();
    const info = vi.fn();
    const check = new TemporalReadinessCheck(
      connection,
      worker as unknown as CheckoutSagaWorker,
      registry,
      config,
      fakePinoLogger({ warn, info }),
    );
    check.onModuleInit();
    const [registered] = registry.all();
    return { registered, getSystemInfo, withDeadline, worker, warn, info };
  };

  it('registers itself as the temporal readiness check', () => {
    expect(build().registered.name).toBe('temporal');
  });

  it('passes while Temporal answers and the worker runs', async () => {
    const { registered, getSystemInfo } = build();

    await expect(registered.check()).resolves.toBeUndefined();
    expect(getSystemInfo).toHaveBeenCalledExactlyOnceWith({});
  });

  // A probe that hangs on Temporal would hold the readiness answer past the orchestrator's timeout.
  it('asks Temporal under a deadline one second out', async () => {
    const { registered, withDeadline } = build();

    await registered.check();

    expect(withDeadline).toHaveBeenCalledWith(NOW.getTime() + 1_000, expect.any(Function));
  });

  it('fails while Temporal does not answer', async () => {
    const { registered, getSystemInfo } = build();
    getSystemInfo.mockRejectedValue(new Error('14 UNAVAILABLE: No connection established'));

    await expect(registered.check()).rejects.toThrow('temporal unreachable');
  });

  it.each<CheckoutSagaWorkerState>(['CONNECTING', 'BACKOFF', 'STOPPING'])(
    'fails while the enabled worker is %s, even with Temporal up',
    async (state) => {
      const { registered } = build({ state });

      await expect(registered.check()).rejects.toThrow(`checkout saga worker is ${state}`);
    },
  );

  it('only asks Temporal when this replica runs no worker', async () => {
    const { registered, worker } = build({ workerEnabled: false, state: 'DISABLED' });

    await expect(registered.check()).resolves.toBeUndefined();
    expect(worker.status).not.toHaveBeenCalled();
  });

  // Probes arrive every few seconds; one line per probe would bury the outage's start and end.
  it('logs when it goes down and when it comes back, not on every probe', async () => {
    const { registered, getSystemInfo, warn, info } = build();
    getSystemInfo.mockRejectedValue(new Error('14 UNAVAILABLE'));

    for (let probe = 0; probe < 3; probe++) await registered.check().catch(() => undefined);
    getSystemInfo.mockResolvedValue({});
    for (let probe = 0; probe < 3; probe++) await registered.check();

    expect(warn).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledOnce();
  });
});
