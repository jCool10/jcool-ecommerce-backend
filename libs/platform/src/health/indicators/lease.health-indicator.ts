import { Injectable } from '@nestjs/common';
import { HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';
import { activeLease } from '@shared/identity/lease/active-lease';

/**
 * Up when this process holds no lease at all — commerce-core mints no bucketed ids and has no node
 * to lose — and down the moment a held lease is fenced, because from then on every mint 503s.
 *
 * Readiness alone stops nothing routing here (plain compose DNS round-robins regardless of health,
 * and Railway stops watching once a deployment is live), which is why the holder also exits. This
 * makes the state visible to anything that does read readiness.
 */
@Injectable()
export class LeaseHealthIndicator {
  constructor(private readonly healthIndicatorService: HealthIndicatorService) {}

  isHealthy(key: string): HealthIndicatorResult {
    const indicator = this.healthIndicatorService.check(key);
    const lease = activeLease();
    if (!lease || lease.isValid) {
      return indicator.up();
    }
    return indicator.down({ message: 'node-id lease lost; minting is fenced' });
  }
}
