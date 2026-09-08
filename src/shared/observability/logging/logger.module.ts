import { ConfigService } from '@nestjs/config';
import { isSpanContextValid, trace } from '@opentelemetry/api';
import { ClsService } from 'nestjs-cls';
import { LoggerModule, type Params } from 'nestjs-pino';
import { JOB_NAME_KEY } from '../correlation/job-context';
import { redactPaths } from './redact-paths';

const REDACT_CENSOR = '[Redacted]';

/**
 * autoLogging is OFF on purpose — {@link CanonicalLogInterceptor} owns the single completion line.
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
        mixin(): Record<string, string> {
          const fields: Record<string, string> = {};
          if (cls.isActive()) {
            const requestId = cls.getId();
            if (requestId) fields.requestId = requestId;
            // Set only by runInJobContext, so its presence answers "request or timer?" — something
            // the requestId alone cannot tell you.
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
