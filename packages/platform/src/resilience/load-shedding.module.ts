import { Module } from '@nestjs/common';
import { LOAD_SHEDDING_METRIC_PROVIDERS } from '../observability/metrics/metric-definitions';
import { LoadSheddingMiddleware } from './load-shedding.middleware';

/**
 * Mounted by the app itself, `app.use(app.get(LoadSheddingMiddleware).handle)` right after CORS, so a
 * shed request costs the edge middleware and nothing behind it, and its 503 still carries CORS headers.
 */
@Module({
  providers: [LoadSheddingMiddleware, ...LOAD_SHEDDING_METRIC_PROVIDERS],
  exports: [LoadSheddingMiddleware],
})
export class LoadSheddingModule {}
