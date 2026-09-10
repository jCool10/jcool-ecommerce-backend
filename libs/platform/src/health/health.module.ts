import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { DrizzleHealthIndicator, RedisHealthIndicator, ShutdownHealthIndicator } from './indicators';
import { ShutdownService } from './shutdown.service';

// ShutdownService is a plain provider so its BeforeApplicationShutdown hook fires on SIGTERM,
// which is what feeds the shutdown-aware readiness gate.
@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
  providers: [DrizzleHealthIndicator, RedisHealthIndicator, ShutdownHealthIndicator, ShutdownService],
})
export class HealthModule {}
