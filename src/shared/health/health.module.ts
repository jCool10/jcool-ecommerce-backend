import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { DrizzleHealthIndicator, RedisHealthIndicator, ShutdownHealthIndicator } from './indicators';
import { ShutdownService } from './shutdown.service';

// Health surface. DRIZZLE/RedisService come from their @Global modules, so this
// only declares the indicators + controller. ShutdownService is a plain provider so its
// BeforeApplicationShutdown hook fires on SIGTERM (feeds the shutdown-aware readiness gate).
@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
  providers: [DrizzleHealthIndicator, RedisHealthIndicator, ShutdownHealthIndicator, ShutdownService],
})
export class HealthModule {}
