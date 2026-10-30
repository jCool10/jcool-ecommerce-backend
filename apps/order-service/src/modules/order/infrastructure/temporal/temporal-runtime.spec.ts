import type { Logger, RuntimeOptions } from '@temporalio/worker';
import type { PinoLogger } from 'nestjs-pino';
import { installTemporalRuntime } from './temporal-runtime';

const install = vi.hoisted(() => vi.fn<(options: RuntimeOptions) => void>());

vi.mock('@temporalio/worker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@temporalio/worker')>()),
  Runtime: { _instance: undefined, install },
}));

describe('installTemporalRuntime', () => {
  const pino = { warn: vi.fn(), error: vi.fn() };

  const installedLogger = (): Logger => {
    installTemporalRuntime(pino as unknown as PinoLogger);
    return install.mock.calls[0][0].logger as Logger;
  };

  beforeEach(() => {
    install.mockClear();
    pino.warn.mockClear();
    pino.error.mockClear();
  });

  it('leaves SIGTERM to Nest', () => {
    installTemporalRuntime();

    expect(install).toHaveBeenCalledWith(expect.objectContaining({ shutdownSignals: [] }));
  });

  it('forwards the native core warnings to the same logger instead of raw stderr', () => {
    installTemporalRuntime(pino as unknown as PinoLogger);

    expect(install).toHaveBeenCalledWith(
      expect.objectContaining({ telemetryOptions: { logging: { filter: { core: 'WARN' }, forward: {} } } }),
    );
  });

  it('sends SDK and workflow warnings through pino, with the error as err', () => {
    const logger = installedLogger();
    const error = new Error('nondeterminism');

    logger.warn('payment authorization not verified', { workflowId: 'checkout-1', verdict: 'NOT_AUTHORIZED' });
    logger.error('workflow task failed', { workflowId: 'checkout-1', error });

    expect(pino.warn).toHaveBeenCalledWith(
      { workflowId: 'checkout-1', verdict: 'NOT_AUTHORIZED' },
      'payment authorization not verified',
    );
    expect(pino.error).toHaveBeenCalledWith({ workflowId: 'checkout-1', err: error }, 'workflow task failed');
  });

  it('drops anything below warn', () => {
    const logger = installedLogger();

    logger.info('worker polling');
    logger.debug('activation');

    expect(pino.warn).not.toHaveBeenCalled();
    expect(pino.error).not.toHaveBeenCalled();
  });
});
