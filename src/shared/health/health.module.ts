import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { DrizzleHealthIndicator } from './indicators/drizzle.health-indicator';
import { RedisHealthIndicator } from './indicators/redis.health-indicator';

// Health surface. DRIZZLE/RedisService come from their @Global modules, so this
// only declares the indicators + controller.
@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
  providers: [DrizzleHealthIndicator, RedisHealthIndicator],
})
export class HealthModule {}
