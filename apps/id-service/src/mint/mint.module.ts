import { Module } from '@nestjs/common';
import { LeaseModule } from '../lease/lease.module';
import { MintController } from './mint.controller';
import { MINT_METRIC_PROVIDERS } from './mint.metrics';

@Module({
  imports: [LeaseModule],
  controllers: [MintController],
  providers: [...MINT_METRIC_PROVIDERS],
})
export class MintModule {}
