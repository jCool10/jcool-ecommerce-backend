import type { ConfigService } from '@nestjs/config';
import { isSpanContextValid, trace } from '@opentelemetry/api';
import type { ClsService } from 'nestjs-cls';
import type { Params } from 'nestjs-pino';
import { destination, type Level, multistream, transport, type TransportSingleOptions } from 'pino';
import type { LokiOptions } from 'pino-loki';
import { JOB_NAME_KEY } from '../correlation/job-context';
import { redactPaths } from './redact-paths';
import { requestWithoutQuery } from './request-serializer';

const REDACT_CENSOR = '[Redacted]';

const PRETTY_TRANSPORT: TransportSingleOptions = {
  target: 'pino-pretty',
  options: {
    singleLine: true,
    translateTime: 'SYS:standard',
    ignore: 'pid,hostname',
  },
};

export function createLoggerParams(config: ConfigService, cls: ClsService): Params {
  const env = config.get<string>('app.env');
  const level = config.get<string>('log.level') ?? 'info';
  const pretty = env === 'development';
  const lokiUrl = config.get<string>('loki.url');

  const options = {
    level,
    autoLogging: false,
    redact: { paths: redactPaths, censor: REDACT_CENSOR },
    serializers: { req: requestWithoutQuery },
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
  };

  if (!lokiUrl) {
    return { pinoHttp: { ...options, ...(pretty ? { transport: PRETTY_TRANSPORT } : {}) } };
  }

  // stdout stays the same main-thread stream it is without Loki; only the Loki copy runs in a worker,
  // so a slow or dead Loki never blocks a request and stdout keeps every line regardless.
  const stdout = pretty ? transport(PRETTY_TRANSPORT) : destination(1);
  const loki = transport<LokiOptions>({
    target: 'pino-loki',
    // Otherwise the worker inherits `--import ./dist/instrumentation.js` and boots a second OTel SDK
    // and Sentry client.
    worker: { execArgv: [] },
    options: {
      host: lokiUrl,
      // Few, bounded labels; requestId and traceId stay in the line, queried with `| json`.
      labels: {
        service: config.getOrThrow<string>('tracing.serviceName'),
        env: config.getOrThrow<string>('app.env'),
      },
      // Its default ('meta') would turn any `meta` field into structured metadata.
      structuredMetaKey: false,
    },
  });
  // A dead worker emits 'error' on every write, and an unheard 'error' crashes the process.
  let lokiFailed = false;
  loki.on('error', (error: Error) => {
    if (lokiFailed) return;
    lokiFailed = true;
    process.stderr.write(`Loki transport failed, logging to stdout only: ${error.message}\n`);
  });
  const streamLevel = level as Level;

  return {
    pinoHttp: [
      options,
      multistream([
        { level: streamLevel, stream: stdout },
        { level: streamLevel, stream: loki },
      ]),
    ],
  };
}
