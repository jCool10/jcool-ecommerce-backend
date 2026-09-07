import { Injectable } from '@nestjs/common';
import type { RetentionSweep } from './retention-sweep.port';

/**
 * Where the sweeps a running app owns are collected.
 *
 * A provider rather than a module-level array: an array at module scope outlives the app that
 * filled it, so in e2e the second app's scheduler would drive the first app's sweeps against a
 * closed pool.
 *
 * Nest has no `multi: true` provider, so each sweep registers itself rather than this collecting
 * them — which is also what keeps `shared/` from importing `modules/`.
 */
@Injectable()
export class RetentionSweepRegistry {
  private readonly sweeps = new Map<string, RetentionSweep>();

  /**
   * Called by each sweep during its own `onModuleInit`. A duplicate name throws rather than
   * silently replacing — two sweeps under one name would share a metric label and one would never
   * run.
   */
  register(sweep: RetentionSweep): void {
    const existing = this.sweeps.get(sweep.name);
    if (existing && existing !== sweep) {
      throw new Error(`Duplicate retention sweep name "${sweep.name}" — names are metric labels and must be unique`);
    }
    this.sweeps.set(sweep.name, sweep);
  }

  /** Registration order is not meaningful; the scheduler runs them all in one tick. */
  all(): readonly RetentionSweep[] {
    return [...this.sweeps.values()];
  }

  /** The registered names, for the boot-time log that makes a forgotten `register()` visible. */
  names(): readonly string[] {
    return [...this.sweeps.keys()];
  }
}
