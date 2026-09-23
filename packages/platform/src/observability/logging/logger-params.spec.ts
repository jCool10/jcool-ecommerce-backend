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

function httpOptions(config: Record<string, unknown>, cls: ClsService = inactiveCls): Options {
  return createLoggerParams(fakeConfigService(config), cls).pinoHttp as Options;
}

function mixinFields(options: Options): Record<string, string> {
  return (options.mixin as () => Record<string, string>)();
}

describe('createLoggerParams — pino-http options', () => {
  it('uses the configured level', () => {
    expect(httpOptions({ 'app.env': 'production', 'log.level': 'warn' }).level).toBe('warn');
  });

  it('falls back to info when no level is configured', () => {
    expect(httpOptions({ 'app.env': 'production' }).level).toBe('info');
  });

  it('leaves the completion line to CanonicalLogInterceptor', () => {
    expect(httpOptions({ 'app.env': 'production' }).autoLogging).toBe(false);
  });

  it('censors the redact paths', () => {
    expect(httpOptions({ 'app.env': 'production' }).redact).toEqual({ paths: redactPaths, censor: '[Redacted]' });
  });

  it('serializes requests without their query string', () => {
    expect(httpOptions({ 'app.env': 'production' }).serializers).toEqual({ req: requestWithoutQuery });
  });

  it('writes JSON straight to stdout outside development', () => {
    expect(httpOptions({ 'app.env': 'production' }).transport).toBeUndefined();
    expect(httpOptions({ 'app.env': 'test' }).transport).toBeUndefined();
  });

  it('pretty-prints on one line in development', () => {
    expect(httpOptions({ 'app.env': 'development' }).transport).toEqual({
      target: 'pino-pretty',
      options: { singleLine: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' },
    });
  });
});

describe('createLoggerParams — mixin', () => {
  it('adds nothing outside a CLS context', () => {
    expect(mixinFields(httpOptions({ 'app.env': 'production' }))).toEqual({});
  });

  it('adds the requestId inside a request', () => {
    expect(mixinFields(httpOptions({ 'app.env': 'production' }, clsWith('req-1')))).toEqual({ requestId: 'req-1' });
  });

  it('adds the job name inside a job context', () => {
    expect(mixinFields(httpOptions({ 'app.env': 'production' }, clsWith('req-2', 'retention-sweep')))).toEqual({
      requestId: 'req-2',
      job: 'retention-sweep',
    });
  });

  it('adds the userId once the request is authenticated', () => {
    const request = { user: { userId: '7318349394477056', role: 'CUSTOMER' } };
    expect(mixinFields(httpOptions({ 'app.env': 'production' }, clsWith('req-3', undefined, request)))).toEqual({
      requestId: 'req-3',
      userId: '7318349394477056',
    });
  });

  it('adds no userId before authentication', () => {
    expect(mixinFields(httpOptions({ 'app.env': 'production' }, clsWith('req-4', undefined, {})))).toEqual({
      requestId: 'req-4',
    });
  });

  describe('with an active span', () => {
    const spanContext = {
      traceId: '0af7651916cd43dd8448eb211c80319c',
      spanId: 'b7ad6b7169203331',
      traceFlags: TraceFlags.SAMPLED,
    };

    beforeAll(() => {
      context.disable();
      context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    });

    afterAll(() => {
      context.disable();
    });

    it('adds the traceId and spanId', () => {
      const options = httpOptions({ 'app.env': 'production' });
      const active = trace.setSpan(context.active(), trace.wrapSpanContext(spanContext));

      expect(context.with(active, () => mixinFields(options))).toEqual({
        traceId: spanContext.traceId,
        spanId: spanContext.spanId,
      });
    });
  });
});

describe('createLoggerParams — Loki', () => {
  const LOKI_URL = 'http://loki.railway.internal:3100';

  function lokiParams(config: Record<string, unknown>): [Options, unknown] {
    const params = createLoggerParams(
      fakeConfigService({ 'loki.url': LOKI_URL, 'tracing.serviceName': 'jcool-api', ...config }),
      inactiveCls,
    );
    return params.pinoHttp as [Options, unknown];
  }

  const lokiStream = expect.objectContaining({ target: 'pino-loki' }) as unknown;

  function lokiTransport(): EventEmitter {
    const index = vi
      .mocked(transport)
      .mock.calls.findIndex(([options]) => 'target' in options && options.target === 'pino-loki');
    return vi.mocked(transport).mock.results[index].value as EventEmitter;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts no transport when LOKI_URL is unset', () => {
    const pinoHttp = createLoggerParams(fakeConfigService({ 'app.env': 'production' }), inactiveCls).pinoHttp;

    expect(Array.isArray(pinoHttp)).toBe(false);
    expect(transport).not.toHaveBeenCalled();
  });

  it('pushes to Loki labelled by service and environment', () => {
    lokiParams({ 'app.env': 'production' });

    expect(transport).toHaveBeenCalledWith(
      expect.objectContaining({
        target: 'pino-loki',
        options: { host: LOKI_URL, labels: { service: 'jcool-api', env: 'production' }, structuredMetaKey: false },
      }),
    );
  });

  // The api starts with `node --import ./dist/instrumentation.js`, which a worker inherits by default.
  it('keeps the OTel and Sentry preload out of the Loki worker', () => {
    lokiParams({ 'app.env': 'production' });

    expect(transport).toHaveBeenCalledWith(expect.objectContaining({ target: 'pino-loki', worker: { execArgv: [] } }));
  });

  it('survives the Loki worker dying, reporting it once', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    lokiParams({ 'app.env': 'production' });

    expect(() => {
      lokiTransport().emit('error', new Error('the worker has exited'));
      lokiTransport().emit('error', new Error('the worker has exited'));
    }).not.toThrow();
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('the worker has exited'));

    stderr.mockRestore();
  });

  it('keeps writing to stdout alongside Loki', () => {
    const [options, stream] = lokiParams({ 'app.env': 'production', 'log.level': 'debug' });

    expect(destination).toHaveBeenCalledWith(1);
    expect(multistream).toHaveBeenCalledWith([
      { level: 'debug', stream: { fd: 1 } },
      { level: 'debug', stream: lokiStream },
    ]);
    expect(stream).toEqual({ streams: vi.mocked(multistream).mock.calls[0][0] });
    expect(options).toMatchObject({ level: 'debug', autoLogging: false });
    expect(options.transport).toBeUndefined();
  });

  it('defaults both streams to info', () => {
    lokiParams({ 'app.env': 'production' });

    expect(multistream).toHaveBeenCalledWith([
      { level: 'info', stream: { fd: 1 } },
      { level: 'info', stream: lokiStream },
    ]);
  });

  it('keeps the rest of the options when shipping to Loki', () => {
    const [options] = lokiParams({ 'app.env': 'production' });

    expect(options.redact).toEqual({ paths: redactPaths, censor: '[Redacted]' });
    expect(options.serializers).toEqual({ req: requestWithoutQuery });
    expect(options.mixin).toBeTypeOf('function');
  });

  it('still pretty-prints stdout in development', () => {
    const [options] = lokiParams({ 'app.env': 'development' });

    expect(transport).toHaveBeenCalledWith({
      target: 'pino-pretty',
      options: { singleLine: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' },
    });
    expect(destination).not.toHaveBeenCalled();
    expect(multistream).toHaveBeenCalledWith([
      { level: 'info', stream: expect.objectContaining({ target: 'pino-pretty' }) as unknown },
      { level: 'info', stream: lokiStream },
    ]);
    expect(options.transport).toBeUndefined();
  });
});
