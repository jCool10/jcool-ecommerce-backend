import { Injectable } from '@nestjs/common';
import { HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';
import { NodeLease } from '@jcool/id-generator';

@Injectable()
export class LeaseHealthIndicator {
  constructor(
    private readonly healthIndicatorService: HealthIndicatorService,
    private readonly lease: NodeLease,
  ) {}

  isHealthy(key: string): HealthIndicatorResult {
    const indicator = this.healthIndicatorService.check(key);
    const { state, nodeId } = this.lease;
    return state === 'held' || state === 'draining' ? indicator.up({ nodeId }) : indicator.down({ state });
  }
}
