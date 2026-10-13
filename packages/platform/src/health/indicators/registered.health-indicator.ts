import { Injectable } from '@nestjs/common';
import { HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';
import type { ReadinessCheck } from '../readiness-check.registry';

@Injectable()
export class RegisteredHealthIndicator {
  constructor(private readonly healthIndicatorService: HealthIndicatorService) {}

  async isHealthy(check: ReadinessCheck): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check(check.name);
    const ready = await check.isReady().catch(() => false);
    return ready ? indicator.up() : indicator.down({ message: `${check.name} unavailable` });
  }
}
