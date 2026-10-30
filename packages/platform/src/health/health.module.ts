import { Global, Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { DrizzleHealthIndicator, RedisHealthIndicator, ShutdownHealthIndicator } from './indicators';
import { ReadinessCheckRegistry } from './readiness-check.registry';
import { ShutdownService } from './shutdown.service';

// ShutdownService is a plain provider so its BeforeApplicationShutdown hook fires on SIGTERM,
// which is what feeds the shutdown-aware readiness gate. Global so any module can register a
// shutdown step or a readiness check on the one instance the controller reads.
@Global()
@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
  providers: [
    DrizzleHealthIndicator,
    RedisHealthIndicator,
    ShutdownHealthIndicator,
    ShutdownService,
    ReadinessCheckRegistry,
  ],
  exports: [ShutdownService, ReadinessCheckRegistry],
})
export class HealthModule {}
