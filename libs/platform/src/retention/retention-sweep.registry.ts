import { Injectable } from '@nestjs/common';
import type { RetentionSweep } from './retention-sweep.port';

/**
 * A provider rather than a module-scope array: an array at module scope outlives the app that filled
 * it, so in e2e a second app's scheduler would drive the first app's sweeps against a closed pool.
 * Sweeps self-register because Nest has no `multi: true`, which also keeps `shared/` off `modules/`.
 */
@Injectable()
export class RetentionSweepRegistry {
  private readonly sweeps = new Map<string, RetentionSweep>();

  /** Called by each sweep during its own `onModuleInit`. */
  register(sweep: RetentionSweep): void {
    const existing = this.sweeps.get(sweep.name);
    if (existing && existing !== sweep) {
      throw new Error(`Duplicate retention sweep name "${sweep.name}" — names are metric labels and must be unique`);
    }
    this.sweeps.set(sweep.name, sweep);
  }

  all(): readonly RetentionSweep[] {
    return [...this.sweeps.values()];
  }

  names(): readonly string[] {
    return [...this.sweeps.keys()];
  }
}
