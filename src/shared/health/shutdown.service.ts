import { BeforeApplicationShutdown, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// Tracks whether the process has begun a graceful shutdown so /health/ready can report
// 503 the moment SIGTERM/SIGINT arrives — a load balancer then stops routing to this
// instance BEFORE the HTTP server actually closes, so no new request hits a half-drained
// process. Liveness stays untouched: the process is still alive while it drains.
@Injectable()
export class ShutdownService implements BeforeApplicationShutdown {
  private readonly logger = new Logger(ShutdownService.name);
  private shuttingDown = false;
  private readonly gracePeriodMs: number;

  constructor(config: ConfigService) {
    this.gracePeriodMs = config.get<number>('app.shutdownGracePeriodMs') ?? 0;
  }

  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  // Nest (main.ts enableShutdownHooks) calls this on SIGTERM/SIGINT, before it disposes
  // the HTTP server. Flip the flag first so readiness immediately 503s, then hold for the
  // configured grace so an orchestrator can observe the 503 and drain this instance. A
  // grace of 0 (the default) keeps tests and local dev shutting down instantly.
  async beforeApplicationShutdown(signal?: string): Promise<void> {
    this.shuttingDown = true;
    this.logger.log(
      `Shutdown signal ${signal ?? 'unknown'} received; /health/ready now returns 503 (grace ${this.gracePeriodMs}ms)`,
    );
    if (this.gracePeriodMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, this.gracePeriodMs));
    }
  }
}
