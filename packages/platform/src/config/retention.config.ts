import { Type } from 'class-transformer';
import { IsBooleanString, IsInt, IsOptional, Max, Min } from 'class-validator';
import { parseIntOr } from './env-parsers';
import type { EnvBase } from './validate-env';

/** The scheduler's own knobs. Per-table horizons belong to the context that owns the table. */
export function RetentionEnv<TBase extends EnvBase>(Base: TBase) {
  class RetentionEnv extends Base {
    @IsOptional()
    @IsBooleanString()
    RETENTION_ENABLED?: string;

    // Min 1000 so a typo can't turn hourly housekeeping into a loop issuing DELETEs as fast as the
    // pool allows.
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1000)
    RETENTION_INTERVAL_MS?: number;

    // Capped because a larger batch holds row locks on a table the request path is writing to for
    // proportionally longer.
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(10_000)
    RETENTION_BATCH_SIZE?: number;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(100)
    RETENTION_SWEEP_TIMEOUT_MS?: number;
  }
  return RetentionEnv;
}

export const retentionConfig = () => ({
  retention: {
    enabled: process.env.RETENTION_ENABLED !== 'false',
    // Housekeeping, not correctness — sized to keep load off the hot path, not to meet a deadline.
    intervalMs: parseIntOr(process.env.RETENTION_INTERVAL_MS, 3_600_000),
    // Rows one sweep may delete per tick — also the bound on how long one DELETE holds row locks.
    batchSize: parseIntOr(process.env.RETENTION_BATCH_SIZE, 500),
    // Ends the scheduler's wait, not the statement, so its job is to stop one blocked table from
    // holding the tick.
    sweepTimeoutMs: parseIntOr(process.env.RETENTION_SWEEP_TIMEOUT_MS, 30_000),
  },
});
