import type { ConfigService } from '@nestjs/config';
import type { ClsService } from 'nestjs-cls';
import type { Options } from 'pino-http';
import { describe, expect, it } from 'vitest';
import { getLogDestination } from './log-destination';
import { buildLoggerParams } from './logger.module';

// The factory only ever calls config.get(path), so a map stands in for the whole ConfigService.
function configStub(values: Record<string, unknown>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

const clsStub = { isActive: () => false } as unknown as ClsService;

// An active CLS holding whatever the request has accumulated so far.
function activeCls(values: Record<string, unknown> = {}): ClsService {
  return {
    isActive: () => true,
    getId: () => 'req-1',
    get: (key: string) => values[key],
  } as unknown as ClsService;
}

const PROD_CONFIG = {
  'app.env': 'production',
  'log.level': 'info',
  'log.service': 'jcool-api',
  'log.version': 'abc123def456',
};

// The factory returns nestjs-pino Params; pinoHttp is the pino option object when no destination
// tuple is supplied.
function prodOptions(overrides: Record<string, unknown> = {}): Options {
  const { pinoHttp } = buildLoggerParams(configStub({ ...PROD_CONFIG, ...overrides }), clsStub);
  // Production hands nestjs-pino an [options, destination] tuple; every other env hands it options.
  return (Array.isArray(pinoHttp) ? pinoHttp[0] : pinoHttp) as Options;
}

describe('buildLoggerParams — production wire format', () => {
  it('stamps service/env/version on every line', () => {
    expect(prodOptions().base).toEqual({ service: 'jcool-api', env: 'production', version: 'abc123def456' });
  });

  // pid is meaningless in a container and hostname is a disposable id; both were replaced by base.
  it('drops pino default base (pid, hostname)', () => {
    const base = prodOptions().base as Record<string, unknown>;

    expect(base).not.toHaveProperty('pid');
    expect(base).not.toHaveProperty('hostname');
  });

  // A numeric level makes every log-platform query read `level:30`; the word is what people filter on.
  it('emits level as a word, not a number', () => {
    const format = prodOptions().formatters?.level;

    expect(format?.('warn', 40)).toEqual({ level: 'warn' });
    expect(format?.('info', 30)).toEqual({ level: 'info' });
  });

  it('emits time as ISO-8601', () => {
    const timestamp = prodOptions().timestamp;
    const rendered = typeof timestamp === 'function' ? timestamp() : String(timestamp);

    expect(rendered).toMatch(/^,"time":"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z"$/);
  });

  it('keeps autoLogging off so the canonical interceptor owns the request line', () => {
    expect(prodOptions().autoLogging).toBe(false);
  });

  // Without this, pino-http binds the serialized request onto the per-request child, so every line
  // in the request repeats the url WITH its query string — and `/auth/verify-email?token=…` carries
  // a single-use credential no redact path can reach (it is a substring of a url, not a key).
  it('binds nothing per request, so no line can carry a query string', () => {
    const options = prodOptions();

    expect(options.quietReqLogger).toBe(true);
    // quietReqLogger would otherwise bind `reqId`; an unset id makes pino omit the binding.
    expect(options.genReqId?.({} as never, {} as never)).toBeUndefined();
  });

  // pino-pretty is a dev-only concern: a transport in production would put a worker thread between
  // the process and stdout for no gain.
  it('wires the pretty transport in development only', () => {
    expect(prodOptions().transport).toBeUndefined();
    expect(prodOptions({ 'app.env': 'development' }).transport).toMatchObject({ target: 'pino-pretty' });
  });

  // base fields are for the log platform, not for a human reading the dev console.
  it('hides base fields from the dev pretty line', () => {
    const transport = prodOptions({ 'app.env': 'development' }).transport as unknown as {
      options: { ignore: string };
    };

    expect(transport.options.ignore).toContain('service');
    expect(transport.options.ignore).toContain('version');
  });

  // The actor belongs on EVERY line, not just the summary — filtering by one user should return
  // the whole story of their request.
  it('stamps the actor on every line of an authenticated request', () => {
    const { pinoHttp } = buildLoggerParams(
      configStub(PROD_CONFIG),
      activeCls({ actor: { userId: 'user-8', role: 'ADMIN' } }),
    );
    const options = (Array.isArray(pinoHttp) ? pinoHttp[0] : pinoHttp) as Options;

    expect(options.mixin?.({}, 30, undefined as never)).toEqual({
      requestId: 'req-1',
      userId: 'user-8',
      role: 'ADMIN',
    });
  });

  // Absent, not empty — `userId:*` is then itself the "authenticated traffic" filter.
  it('omits actor fields on an anonymous request', () => {
    const { pinoHttp } = buildLoggerParams(configStub(PROD_CONFIG), activeCls());
    const options = (Array.isArray(pinoHttp) ? pinoHttp[0] : pinoHttp) as Options;

    expect(options.mixin?.({}, 30, undefined as never)).toEqual({ requestId: 'req-1' });
  });

  // The shutdown hook flushes the destination the logger writes into; that only works if
  // production hands nestjs-pino the flushable one, and only production needs the batching.
  it('writes production through the flushable destination, other envs through pino defaults', () => {
    const prod = buildLoggerParams(configStub(PROD_CONFIG), clsStub).pinoHttp;
    const test = buildLoggerParams(configStub({ ...PROD_CONFIG, 'app.env': 'test' }), clsStub).pinoHttp;

    expect(Array.isArray(prod)).toBe(true);
    expect((prod as [unknown, unknown])[1]).toBe(getLogDestination());
    expect(Array.isArray(test)).toBe(false);
  });
});
