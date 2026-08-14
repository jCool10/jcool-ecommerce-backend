import { ConfigService } from '@nestjs/config';
import { ClsService } from 'nestjs-cls';
import { LoggerModule, type Params } from 'nestjs-pino';
import { redactPaths } from './redact-paths';

const REDACT_CENSOR = '[Redacted]';

/**
 * App-wide structured logging (pino): one JSON line per log to stdout (12-factor);
 * `pino-pretty` only in local development (never a worker thread in test/prod). A pino
 * `mixin` stamps every line with the CLS requestId so logs — and, from Phase 3, traces —
 * share one join key. See ADR-0013.
 *
 * `autoLogging` is OFF: {@link CanonicalLogInterceptor} owns the single "request
 * completed" line (so it can attach `db.queries`); pino-http's own request log would
 * otherwise double it.
 */
export const ObservabilityLoggerModule = LoggerModule.forRootAsync({
  inject: [ConfigService, ClsService],
  useFactory: (config: ConfigService, cls: ClsService): Params => {
    const env = config.get<string>('app.env');
    const level = config.get<string>('log.level') ?? 'info';
    const pretty = env === 'development';

    return {
      pinoHttp: {
        level,
        autoLogging: false,
        redact: { paths: redactPaths, censor: REDACT_CENSOR },
        // Runs on every log inside a request's async context → one requestId per line,
        // order-independent of middleware (unlike pino-http's genReqId/customProps).
        mixin(): Record<string, string> {
          if (!cls.isActive()) return {};
          const requestId = cls.getId();
          return requestId ? { requestId } : {};
        },
        ...(pretty
          ? { transport: { target: 'pino-pretty', options: { singleLine: true, translateTime: 'SYS:standard' } } }
          : {}),
      },
    };
  },
});
