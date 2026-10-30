import { Injectable } from '@nestjs/common';

export interface ReadinessCheck {
  /** Its key in the `/health/ready` body. */
  name: string;
  /** Resolves when ready. Rejects to report down, with the error's message as the reason; bounds its own wait. */
  check: () => Promise<void>;
}

// Always checked first, by the controller itself.
const BUILT_IN = ['shutdown', 'database', 'redis'];

/**
 * Dependencies a service adds to its readiness beyond Postgres and Redis, registered from the owning
 * module's `onModuleInit`. A provider rather than a module-scope array, for the same reason as
 * `RetentionSweepRegistry`: two e2e apps must not share one roster.
 */
@Injectable()
export class ReadinessCheckRegistry {
  private readonly checks = new Map<string, ReadinessCheck>();

  register(check: ReadinessCheck): void {
    if (BUILT_IN.includes(check.name) || this.checks.has(check.name)) {
      throw new Error(`readiness check "${check.name}" is already registered`);
    }
    this.checks.set(check.name, check);
  }

  all(): readonly ReadinessCheck[] {
    return [...this.checks.values()];
  }
}
