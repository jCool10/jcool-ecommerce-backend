import { Global, Module } from '@nestjs/common';
import { RedisService } from './redis.service';

// @Global so any context can inject RedisService without re-importing this module.
@Global()
@Module({
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}
