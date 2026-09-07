import { ConfigService } from '@nestjs/config';
import { isSpanContextValid, trace } from '@opentelemetry/api';
import { ClsService } from 'nestjs-cls';
import { LoggerModule, type Params } from 'nestjs-pino';
import { JOB_NAME_KEY } from '../correlation/job-context';
import { redactPaths } from './redact-paths';

const REDACT_CENSOR = '[Redacted]';

/**
 * App-wide structured logging (pino): one JSON line per log to stdout, pino-pretty only in
 * dev. A mixin stamps each line with the CLS requestId (and traceId/spanId when tracing is
 * on). autoLogging is OFF — {@link CanonicalLogInterceptor} owns the single completion line.
 * See ADR-0013.
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
        // Adds requestId (and traceId/spanId when a span is active) to every log line.
        mixin(): Record<string, string> {
          const fields: Record<string, string> = {};
          if (cls.isActive()) {
            const requestId = cls.getId();
            if (requestId) fields.requestId = requestId;
            // Set only by runInJobContext, so its presence is also the answer to "was this line
            // produced by a request or by a timer" — which the requestId alone cannot tell you.
            const jobName = cls.get<string>(JOB_NAME_KEY);
            if (jobName) fields.job = jobName;
          }
          const spanContext = trace.getActiveSpan()?.spanContext();
          if (spanContext && isSpanContextValid(spanContext)) {
            fields.traceId = spanContext.traceId;
            fields.spanId = spanContext.spanId;
          }
          return fields;
        },
        ...(pretty
          ? {
              transport: {
                target: 'pino-pretty',
                options: {
                  singleLine: true,
                  translateTime: 'SYS:standard',
                  ignore: 'pid,hostname',
                },
              },
            }
          : {}),
      },
    };
  },
});
