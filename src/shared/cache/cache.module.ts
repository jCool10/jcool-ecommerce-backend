import { Module } from '@nestjs/common';
import { CacheService } from './cache.service';

// Not @Global: a context opts into caching by importing this, keeping the set of
// cache-aware modules visible in the wiring. RedisService comes from the global RedisModule.
@Module({
  providers: [CacheService],
  exports: [CacheService],
})
export class CacheModule {}
