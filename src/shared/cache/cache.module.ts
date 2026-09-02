import { Module } from '@nestjs/common';
import { CacheService } from './cache.service';
import { SingleFlightLock } from './single-flight.lock';
import { SwrCacheService } from './swr-cache.service';

// Not @Global: a context opts into caching by importing this, keeping the set of
// cache-aware modules visible in the wiring. RedisService comes from the global RedisModule.
@Module({
  providers: [CacheService, SingleFlightLock, SwrCacheService],
  exports: [CacheService, SingleFlightLock, SwrCacheService],
})
export class CacheModule {}
