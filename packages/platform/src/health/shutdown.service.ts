import { BeforeApplicationShutdown, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import { toError } from '@jcool/kernel';

const LOG_CONTEXT = 'ShutdownService';

// Lower runs first. Every step ends before onApplicationShutdown closes the pg pool and Redis, so
// whatever a worker is still draining keeps its connections.
export const SHUTDOWN_STEP_ORDER = {
  DRAIN_WORKFLOW_WORKER: 100,
  CLOSE_QUEUE_WORKER: 200,
} as const;

export interface ShutdownStep {
  name: string;
  order: number;
  // Must bound its own wait: the steps run one after another inside the platform's draining window.
  run: () => Promise<void>;
}

// /health/ready reports 503 the moment SIGTERM/SIGINT arrives, so a load balancer stops routing
// here BEFORE the HTTP server closes and no new request hits a half-drained process. Liveness stays
// untouched: the process is still alive while it drains.
//
// Drains that must happen in a fixed order register a step here instead of their own
// beforeApplicationShutdown: Nest runs same-phase hooks by module distance, not by what depends on what.
@Injectable()
export class ShutdownService implements BeforeApplicationShutdown {
  private shuttingDown = false;
  private shutdown: Promise<void> | null = null;
  private readonly steps = new Map<string, ShutdownStep>();
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

  registerStep(step: ShutdownStep): void {
    if (this.steps.has(step.name)) {
      throw new Error(`shutdown step "${step.name}" is already registered`);
    }
    this.steps.set(step.name, step);
  }

  // Runs before Nest disposes the HTTP server. Flip the flag first so readiness immediately 503s,
  // then hold for the configured grace so an orchestrator can observe the 503 and drain this
  // instance. A grace of 0 (the default) keeps tests and local dev shutting down instantly.
  beforeApplicationShutdown(signal?: string): Promise<void> {
    this.shutdown ??= this.drain(signal);
    return this.shutdown;
  }

  private async drain(signal?: string): Promise<void> {
    this.shuttingDown = true;
    this.logger.info(
      { signal: signal ?? 'unknown', gracePeriodMs: this.gracePeriodMs },
      'shutdown signal received; /health/ready now returns 503',
    );
    if (this.gracePeriodMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, this.gracePeriodMs));
    }

    const steps = [...this.steps.values()].sort((a, b) => a.order - b.order);
    if (steps.length === 0) return;
    this.logger.info({ steps: steps.map((step) => step.name) }, 'shutdown grace elapsed; running shutdown steps');

    for (const step of steps) {
      const startedAt = performance.now();
      try {
        await step.run();
        this.logger.info({ step: step.name, durationMs: elapsedMs(startedAt) }, 'shutdown step done');
      } catch (error: unknown) {
        this.logger.error(
          { err: toError(error), step: step.name, durationMs: elapsedMs(startedAt) },
          'shutdown step failed',
        );
      }
    }
  }
}

const elapsedMs = (startedAt: number): number => Math.round(performance.now() - startedAt);
