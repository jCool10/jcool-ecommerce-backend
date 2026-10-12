import { IsInt, IsNotEmpty, IsOptional, IsString, Matches, Min } from 'class-validator';
import { AppEnv, EmptyEnv, ObservabilityEnv, StrictInt, validateEnv } from '@jcool/platform/config';

const PlatformEnv = ObservabilityEnv(AppEnv(EmptyEnv));

/** Bounds only; defaults live in configuration.ts, and how the timings relate is checked by LeaseKeeper. */
export class EnvironmentVariables extends PlatformEnv {
  @IsString()
  @IsNotEmpty()
  @Matches(/^https?:\/\/[^\s,]+(\s*,\s*https?:\/\/[^\s,]+)*$/, {
    message: 'ETCD_ENDPOINTS must be a comma-separated list of http(s):// URLs',
  })
  ETCD_ENDPOINTS!: string;

  // Every key the service writes sits under it, so two deployments can share one etcd.
  @IsOptional()
  @Matches(/^\/(?:[^/\s]+\/)+$/, { message: 'ETCD_KEY_PREFIX must start and end with "/"' })
  ETCD_KEY_PREFIX?: string;

  // 0 would leave a renew against a hung etcd waiting forever, which stalls the keeper.
  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(1)
  ETCD_REQUEST_TIMEOUT_MS?: number;

  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(1_000)
  ID_LEASE_TTL_MS?: number;

  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(100)
  ID_LEASE_RENEW_EVERY_MS?: number;

  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(100)
  ID_LEASE_FENCE_MARGIN_MS?: number;

  @IsOptional()
  @StrictInt()
  @IsInt()
  @Min(0)
  ID_LEASE_MAX_FLOOR_AHEAD_MS?: number;
}

export function validate(config: Record<string, unknown>): EnvironmentVariables {
  return validateEnv(EnvironmentVariables, config);
}
