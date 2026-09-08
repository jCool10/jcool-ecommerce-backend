import { Module } from '@nestjs/common';
import { CacheService } from './cache.service';
import { SingleFlightLock } from './single-flight.lock';
import { SwrCacheService } from './swr-cache.service';

// Deliberately not @Global: importing it keeps the set of cache-aware modules visible in the wiring.
@Module({
  providers: [CacheService, SingleFlightLock, SwrCacheService],
  exports: [CacheService, SingleFlightLock, SwrCacheService],
})
export class CacheModule {}
