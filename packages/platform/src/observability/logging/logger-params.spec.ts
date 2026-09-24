import type { EventEmitter } from 'node:events';
import { context, trace, TraceFlags } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { CLS_REQ, type ClsService } from 'nestjs-cls';
import type { Params } from 'nestjs-pino';
import { destination, multistream, transport, type DestinationStream } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { JOB_NAME_KEY } from '../correlation/job-context';
import { createLoggerParams } from './logger-params';
import { redactPaths } from './redact-paths';
import { requestWithoutQuery } from './request-serializer';

// A real transport would start a worker thread and dial Loki.
vi.mock('pino', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    destination: vi.fn((fd: number) => ({ fd })),
    multistream: vi.fn((streams: unknown[]) => ({ streams })),
    transport: vi.fn((options: { target: string }) => Object.assign(new EventEmitter(), { target: options.target })),
  };
});

type Options = Exclude<NonNullable<Params['pinoHttp']>, DestinationStream | unknown[]>;

const LOKI_URL = 'http://loki.railway.internal:3100';

const inactiveCls = { isActive: () => false } as unknown as ClsService;

function clsWith(requestId: string | undefined, jobName?: string, request?: object): ClsService {
  const values = new Map<string | symbol, unknown>([
    [JOB_NAME_KEY, jobName],
    [CLS_REQ, request],
  ]);
  return {
    isActive: () => true,
    getId: () => requestId,
    get: (key: string | symbol) => values.get(key),
  } as unknown as ClsService;
}

function params(config: Record<string, unknown>, cls: ClsService = inactiveCls): Params['pinoHttp'] {
  return createLoggerParams(fakeConfigService({ 'app.env': 'production', ...config }), cls).pinoHttp;
}

function stdoutOptions(config: Record<string, unknown> = {}, cls: ClsService = inactiveCls): Options {
  return params(config, cls) as Options;
}

function lokiOptions(config: Record<string, unknown> = {}): [Options, unknown] {
  return params({ 'loki.url': LOKI_URL, 'tracing.serviceName': 'jcool-api', ...config }) as [Options, unknown];
}

function mixinFields(options: Options): Record<string, string> {
  return (options.mixin as () => Record<string, string>)();
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createLoggerParams', () => {
  it('uses the configured level, info by default', () => {
    expect([stdoutOptions({ 'log.level': 'warn' }).level, stdoutOptions().level]).toEqual(['warn', 'info']);
  });

  it('keeps redaction, query stripping and autoLogging off with or without Loki', () => {
    const [withLoki] = lokiOptions();

    for (const options of [stdoutOptions(), withLoki]) {
      expect(options).toMatchObject({
        autoLogging: false,
        redact: { paths: redactPaths, censor: '[Redacted]' },
        serializers: { req: requestWithoutQuery },
      });
    }
  });

  it('writes JSON straight to stdout without Loki outside development', () => {
    expect([stdoutOptions().transport, stdoutOptions({ 'app.env': 'test' }).transport]).toEqual([undefined, undefined]);
    expect(transport).not.toHaveBeenCalled();
  });

  it('adds requestId, job and userId from the CLS context when present', () => {
    const authenticated = { user: { userId: '7318349394477056', role: 'CUSTOMER' } };

    expect([
      mixinFields(stdoutOptions()),
      mixinFields(stdoutOptions({}, clsWith('req-1', undefined, {}))),
      mixinFields(stdoutOptions({}, clsWith('req-2', 'retention-sweep'))),
      mixinFields(stdoutOptions({}, clsWith('req-3', undefined, authenticated))),
    ]).toEqual([
      {},
      { requestId: 'req-1' },
      { requestId: 'req-2', job: 'retention-sweep' },
      { requestId: 'req-3', userId: '7318349394477056' },
    ]);
  });

  describe('with an active span', () => {
    beforeAll(() => {
      context.disable();
      context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    });

    afterAll(() => {
      context.disable();
    });

    it('adds the traceId and spanId', () => {
      const spanContext = {
        traceId: '0af7651916cd43dd8448eb211c80319c',
        spanId: 'b7ad6b7169203331',
        traceFlags: TraceFlags.SAMPLED,
      };
      const active = trace.setSpan(context.active(), trace.wrapSpanContext(spanContext));

      expect(context.with(active, () => mixinFields(stdoutOptions()))).toEqual({
        traceId: spanContext.traceId,
        spanId: spanContext.spanId,
      });
    });
  });
});

describe('createLoggerParams with LOKI_URL', () => {
  const lokiTransport = (): EventEmitter => {
    const index = vi
      .mocked(transport)
      .mock.calls.findIndex(([options]) => 'target' in options && options.target === 'pino-loki');
    return vi.mocked(transport).mock.results[index].value as EventEmitter;
  };

  // Loki labels are what every Grafana query selects on; anything per-request stays in the line.
  it('pushes to Loki labelled by service and environment', () => {
    lokiOptions();

    expect(transport).toHaveBeenCalledWith(
      expect.objectContaining({
        target: 'pino-loki',
        options: { host: LOKI_URL, labels: { service: 'jcool-api', env: 'production' }, structuredMetaKey: false },
      }),
    );
  });

  // The api starts with `node --import ./dist/instrumentation.js`, which a worker inherits by default.
  it('keeps the OTel and Sentry preload out of the Loki worker', () => {
    lokiOptions();

    expect(transport).toHaveBeenCalledWith(expect.objectContaining({ target: 'pino-loki', worker: { execArgv: [] } }));
  });

  // An 'error' event nobody listens to crashes the process.
  it('survives the Loki worker dying, reporting it once', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    lokiOptions();

    expect(() => {
      lokiTransport().emit('error', new Error('the worker has exited'));
      lokiTransport().emit('error', new Error('the worker has exited'));
    }).not.toThrow();
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('the worker has exited'));

    stderr.mockRestore();
  });

  it('keeps writing to stdout alongside Loki', () => {
    const [options, stream] = lokiOptions({ 'log.level': 'debug' });

    expect(destination).toHaveBeenCalledWith(1);
    expect(multistream).toHaveBeenCalledWith([
      { level: 'debug', stream: { fd: 1 } },
      { level: 'debug', stream: expect.objectContaining({ target: 'pino-loki' }) as unknown },
    ]);
    expect(stream).toEqual({ streams: vi.mocked(multistream).mock.calls[0][0] });
    expect(options.transport).toBeUndefined();
  });
});
