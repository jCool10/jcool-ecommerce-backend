import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { LeaseModule } from '../lease/lease.module';
import { HealthController } from './health.controller';

@Module({
  imports: [TerminusModule, LeaseModule],
  controllers: [HealthController],
})
export class HealthModule {}
