import { Global, Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { DrizzleHealthIndicator, RedisHealthIndicator, ShutdownHealthIndicator } from './indicators';
import { ShutdownService } from './shutdown.service';

// ShutdownService is a plain provider so its BeforeApplicationShutdown hook fires on SIGTERM,
// which is what feeds the shutdown-aware readiness gate. Global so any module can register a
// shutdown step on the one instance that hook runs on.
@Global()
@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
  providers: [DrizzleHealthIndicator, RedisHealthIndicator, ShutdownHealthIndicator, ShutdownService],
  exports: [ShutdownService],
})
export class HealthModule {}
