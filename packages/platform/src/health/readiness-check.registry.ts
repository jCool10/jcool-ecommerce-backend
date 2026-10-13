import { Injectable } from '@nestjs/common';

/** A dependency a context owns, reported under `name` on `/health/ready`. */
export interface ReadinessCheck {
  readonly name: string;
  /** False or a rejection both mean down. */
  isReady(): Promise<boolean>;
}

/**
 * Same shape as the retention registry, for the same reasons: checks self-register from their own
 * module, so this package never imports a context, and a second app in one process gets its own.
 */
@Injectable()
export class ReadinessCheckRegistry {
  private readonly checks = new Map<string, ReadinessCheck>();

  register(check: ReadinessCheck): void {
    const existing = this.checks.get(check.name);
    if (existing && existing !== check) {
      throw new Error(`Duplicate readiness check name "${check.name}"`);
    }
    this.checks.set(check.name, check);
  }

  all(): readonly ReadinessCheck[] {
    return [...this.checks.values()];
  }
}
