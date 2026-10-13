import { Global, Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller';
import {
  DrizzleHealthIndicator,
  RedisHealthIndicator,
  RegisteredHealthIndicator,
  ShutdownHealthIndicator,
} from './indicators';
import { ReadinessCheckRegistry } from './readiness-check.registry';
import { ShutdownService } from './shutdown.service';

// ShutdownService is a plain provider so its BeforeApplicationShutdown hook fires on SIGTERM,
// which is what feeds the shutdown-aware readiness gate. Global so a context can register its own
// readiness check without importing this module.
@Global()
@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
  providers: [
    DrizzleHealthIndicator,
    RedisHealthIndicator,
    ShutdownHealthIndicator,
    RegisteredHealthIndicator,
    ReadinessCheckRegistry,
    ShutdownService,
  ],
  exports: [ReadinessCheckRegistry],
})
export class HealthModule {}
