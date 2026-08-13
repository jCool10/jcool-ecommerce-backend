import { plainToInstance, Type } from 'class-transformer';
import {
  IsBooleanString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

// Enum so an unexpected NODE_ENV fails validation instead of enabling wrong behavior.
export enum NodeEnv {
  Development = 'development',
  Test = 'test',
  Production = 'production',
}

/**
 * Environment schema, validated once at startup (fail-fast). Required:
 * NODE_ENV, DATABASE_URL, REDIS_URL, JWT_ACCESS_SECRET. Optional vars fall back
 * to defaults applied in configuration.ts.
 */
export class EnvironmentVariables {
  @IsEnum(NodeEnv)
  NODE_ENV!: NodeEnv;

  // Defaults to 3000 (configuration.ts); when present must be a valid TCP port.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT?: number;

  @IsString()
  @IsNotEmpty()
  DATABASE_URL!: string;

  @IsString()
  @IsNotEmpty()
  REDIS_URL!: string;

  @IsOptional()
  @IsBooleanString()
  SWAGGER_ENABLED?: string;

  // Overrides the Secure flag on auth cookies; defaults to on in production only.
  @IsOptional()
  @IsBooleanString()
  COOKIE_SECURE?: string;

  // Rate-limiting kill-switch; defaults to enabled (configuration.ts).
  @IsOptional()
  @IsBooleanString()
  THROTTLE_ENABLED?: string;

  // HMAC secret for access tokens. No safe default → missing fails boot.
  // MinLength(32) enforces a ~256-bit floor for HS256.
  @IsString()
  @MinLength(32)
  JWT_ACCESS_SECRET!: string;

  // TTLs in "15m"/"7d" string form; defaults applied in configuration.ts.
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  JWT_ACCESS_TTL?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  REFRESH_TOKEN_TTL?: string;

  // Argon2id cost overrides; validated here so an out-of-range value fails at boot.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  ARGON2_MEMORY_COST?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  ARGON2_TIME_COST?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  ARGON2_PARALLELISM?: number;
}

// ConfigModule `validate` hook — throws on any violation so the process exits at boot.
export function validate(config: Record<string, unknown>): EnvironmentVariables {
  const validated = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: false,
  });

  const errors = validateSync(validated, { skipMissingProperties: false });

  if (errors.length > 0) {
    const details = errors
      .map((error) => {
        const constraints = Object.values(error.constraints ?? {}).join(', ');
        return `${error.property}: ${constraints}`;
      })
      .join('; ');
    throw new Error(`Environment validation failed -> ${details}`);
  }

  return validated;
}
