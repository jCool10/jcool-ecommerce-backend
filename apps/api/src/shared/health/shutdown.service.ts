import { BeforeApplicationShutdown, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';

const LOG_CONTEXT = 'ShutdownService';

// /health/ready reports 503 the moment SIGTERM/SIGINT arrives, so a load balancer stops routing
// here BEFORE the HTTP server closes and no new request hits a half-drained process. Liveness stays
// untouched: the process is still alive while it drains.
@Injectable()
export class ShutdownService implements BeforeApplicationShutdown {
  private shuttingDown = false;
  private readonly gracePeriodMs: number;

  constructor(
    config: ConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.gracePeriodMs = config.get<number>('app.shutdownGracePeriodMs') ?? 0;
    logger.setContext(LOG_CONTEXT);
  }

  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  // Runs before Nest disposes the HTTP server. Flip the flag first so readiness immediately 503s,
  // then hold for the configured grace so an orchestrator can observe the 503 and drain this
  // instance. A grace of 0 (the default) keeps tests and local dev shutting down instantly.
  async beforeApplicationShutdown(signal?: string): Promise<void> {
    this.shuttingDown = true;
    this.logger.info(
      { signal: signal ?? 'unknown', gracePeriodMs: this.gracePeriodMs },
      'shutdown signal received; /health/ready now returns 503',
    );
    if (this.gracePeriodMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, this.gracePeriodMs));
    }
  }
}
