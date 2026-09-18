import { Type } from 'class-transformer';
import { IsInt, IsOptional, Min } from 'class-validator';
import { AppEnv, DatabaseEnv, EmptyEnv, ObservabilityEnv, validateEnv } from '@jcool/platform/config';

const PlatformEnv = ObservabilityEnv(DatabaseEnv(AppEnv(EmptyEnv)));

/** Bounds only; defaults live in configuration.ts, and how the timings relate is checked by LeaseKeeper. */
export class EnvironmentVariables extends PlatformEnv {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1_000)
  ID_LEASE_TTL_MS?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(100)
  ID_LEASE_RENEW_EVERY_MS?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  ID_LEASE_QUARANTINE_MS?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(100)
  ID_LEASE_FENCE_MARGIN_MS?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  ID_LEASE_MAX_FLOOR_AHEAD_MS?: number;

  // The platform allows 0 (pg waits forever); a renew that never settles would stall the keeper.
  // Redeclared whole: class-validator drops a parent's validators on a property the child redeclares.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  declare DB_QUERY_TIMEOUT_MS?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  declare DB_POOL_CONNECTION_TIMEOUT_MS?: number;
}

export function validate(config: Record<string, unknown>): EnvironmentVariables {
  return validateEnv(EnvironmentVariables, config);
}
