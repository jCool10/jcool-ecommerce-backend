import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import type { NextFunction, Request, Response } from 'express';
import { PinoLogger } from 'nestjs-pino';
import type { Counter, Gauge } from 'prom-client';
import { createLogSampler } from '../observability/logging/log-sampler';
import { HTTP_REQUESTS_IN_FLIGHT, HTTP_REQUESTS_SHED_TOTAL } from '../observability/metrics/metric-definitions';

const LOG_CONTEXT = 'LoadShedding';
const LOG_SAMPLE_WINDOW_MS = 10_000;

export interface LoadSheddingConfig {
  maxInFlight: number;
  retryAfterSec: number;
}

/**
 * Admits at most `maxInFlight` requests at once and answers the rest 503 before any other work runs.
 * The process has one thread: past a few dozen requests in flight a new one only queues behind the
 * others, so admitting it raises every request's latency until Redis commands and pg pool checkouts
 * time out, and an overload turns into errors for everyone instead of a fast refusal for the excess.
 * Health and metrics are never shed, so the platform and Prometheus still see an instance that is.
 */
@Injectable()
export class LoadSheddingMiddleware {
  private inFlight = 0;
  private readonly maxInFlight: number;
  private readonly retryAfter: string;
  private readonly shouldLog = createLogSampler(LOG_SAMPLE_WINDOW_MS);

  constructor(
    config: ConfigService,
    @InjectMetric(HTTP_REQUESTS_SHED_TOTAL) private readonly shed: Counter<string>,
    @InjectMetric(HTTP_REQUESTS_IN_FLIGHT) private readonly inFlightGauge: Gauge<string>,
    private readonly logger: PinoLogger,
  ) {
    const { maxInFlight, retryAfterSec } = config.getOrThrow<LoadSheddingConfig>('resilience.loadShedding');
    this.maxInFlight = maxInFlight;
    this.retryAfter = String(retryAfterSec);
    logger.setContext(LOG_CONTEXT);
  }

  readonly handle = (req: Request, res: Response, next: NextFunction): void => {
    if (this.maxInFlight === 0 || isProbe(req.path)) {
      next();
      return;
    }
    if (this.inFlight >= this.maxInFlight) {
      this.reject(req, res);
      return;
    }
    this.admit(res);
    next();
  };

  private admit(res: Response): void {
    this.inFlight += 1;
    this.inFlightGauge.inc();
    // 'close' fires once whether the response finished or the client went away first.
    res.once('close', () => {
      this.inFlight -= 1;
      this.inFlightGauge.dec();
    });
  }

  private reject(req: Request, res: Response): void {
    this.shed.inc({ method: req.method });
    if (this.shouldLog('shed')) {
      this.logger.warn({ inFlight: this.inFlight, maxInFlight: this.maxInFlight }, 'shedding load');
    }
    res.setHeader('Retry-After', this.retryAfter);
    res.status(503).json({
      statusCode: 503,
      path: req.url,
      timestamp: new Date().toISOString(),
      message: 'Service is overloaded, retry later',
    });
  }
}

function isProbe(path: string): boolean {
  return path === '/metrics' || path === '/health' || path.startsWith('/health/');
}
