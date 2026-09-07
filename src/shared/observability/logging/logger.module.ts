import { ConfigService } from '@nestjs/config';
import { isSpanContextValid, trace } from '@opentelemetry/api';
import { ClsService } from 'nestjs-cls';
import { LoggerModule, type Params } from 'nestjs-pino';
import type { Options } from 'pino-http';
import { ACTOR_KEY, type LogActor } from '../correlation/cls.setup';
import { getLogDestination } from './log-destination';
import { redactPaths } from './redact-paths';
import { ISO_TIMESTAMP, levelAsWord } from './wire-format';

const REDACT_CENSOR = '[Redacted]';

// pino's own base (pid, hostname) is noise in a container — the pid is always 1-ish and the
// hostname is a disposable container id. `service`/`env`/`version` answer the questions those were
// meant to: which app, which environment, which build.
// Hidden from the dev pretty line so local output stays the terse morgan-style single line.
const DEV_PRETTY_IGNORE = 'pid,hostname,service,env,version';

/**
 * The pino wiring behind {@link ObservabilityLoggerModule}, exported so a spec can assert on the
 * options object itself — the wire format is a contract with the log platform, and a shape change
 * should turn a test red rather than a dashboard silent.
 */
export function buildLoggerParams(config: ConfigService, cls: ClsService): Params {
  const env = config.get<string>('app.env');
  const level = config.get<string>('log.level') ?? 'info';
  const pretty = env === 'development';

  const options: Options = {
    level,
    autoLogging: false,
    // pino-http otherwise binds the whole serialized request onto the per-request child logger, so
    // EVERY line in a request repeats the url *with its query string*, the parsed query object and
    // all headers. `/auth/verify-email?token=…` would put a single-use credential on every one of
    // them, and no redact path can help: it is a substring of a url, not a key. The canonical line
    // and the exception filter already carry method + route template, and the CLS mixin carries
    // requestId, so the binding was pure duplication on top of the leak.
    quietReqLogger: true,
    // With quietReqLogger the child binds `reqId` instead — a per-process counter that would sit
    // next to the real `requestId` and mean something different. Returning undefined leaves it
    // unset, and pino omits undefined bindings, so the child carries nothing at all.
    genReqId: () => undefined as unknown as string,
    base: {
      service: config.get<string>('log.service'),
      env,
      version: config.get<string>('log.version'),
    },
    timestamp: ISO_TIMESTAMP,
    // Verified compatible with the pino-pretty transport below (pino 10.3.1), so dev and
    // production share one shape instead of diverging across two config branches.
    formatters: { level: levelAsWord },
    redact: { paths: redactPaths, censor: REDACT_CENSOR },
    // Adds requestId (and traceId/spanId when a span is active) to every log line.
    mixin(): Record<string, string> {
      const fields: Record<string, string> = {};
      if (cls.isActive()) {
        const requestId = cls.getId();
        if (requestId) fields.requestId = requestId;
        // Who, on every line of the request — so filtering by one user returns the whole story of
        // their request, not just its summary. Absent (not empty) on anonymous routes, so
        // `userId:*` is itself the "authenticated traffic" filter.
        const actor = cls.get<LogActor>(ACTOR_KEY);
        if (actor) {
          fields.userId = actor.userId;
          fields.role = actor.role;
        }
      }
      const spanContext = trace.getActiveSpan()?.spanContext();
      if (spanContext && isSpanContextValid(spanContext)) {
        fields.traceId = spanContext.traceId;
        fields.spanId = spanContext.spanId;
      }
      return fields;
    },
  };

  if (pretty) {
    return {
      pinoHttp: {
        ...options,
        transport: {
          target: 'pino-pretty',
          options: { singleLine: true, translateTime: 'SYS:standard', ignore: DEV_PRETTY_IGNORE },
        },
      },
    };
  }

  // Production writes through the batched, flushable destination so a SIGTERM or a crash can push
  // the buffer out on the way down (see log-destination.ts). Test keeps pino's default so a failing
  // suite's last lines reach the runner instead of a buffer nothing flushes.
  return {
    pinoHttp: env === 'production' ? [options, getLogDestination()] : options,
  };
}

/**
 * App-wide structured logging (pino): one JSON line per log to stdout, pino-pretty only in
 * dev. A mixin stamps each line with the CLS requestId (and traceId/spanId when tracing is
 * on). autoLogging is OFF — {@link CanonicalLogInterceptor} owns the single completion line.
 * See ADR-0013.
 */
export const ObservabilityLoggerModule = LoggerModule.forRootAsync({
  inject: [ConfigService, ClsService],
  useFactory: buildLoggerParams,
});
