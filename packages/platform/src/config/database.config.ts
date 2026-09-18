import { Type } from 'class-transformer';
import { IsInt, IsNotEmpty, IsOptional, IsString, Min } from 'class-validator';
import type { EnvBase } from './validate-env';

export function DatabaseEnv<TBase extends EnvBase>(Base: TBase) {
  class DatabaseEnv extends Base {
    @IsString()
    @IsNotEmpty()
    DATABASE_URL!: string;

    // The production image sets this because it ships migrations/ without the src/ tree. Read by the
    // migrate CLI outside Nest, declared here so a blank value fails the boot.
    @IsOptional()
    @IsString()
    @IsNotEmpty()
    MIGRATIONS_DIR?: string;

    // The timeouts allow 0, which opts back into pg's native behaviour (wait forever / never reap idle).
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    DB_POOL_MAX?: number;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(0)
    DB_POOL_CONNECTION_TIMEOUT_MS?: number;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(0)
    DB_POOL_IDLE_TIMEOUT_MS?: number;
  }
  return DatabaseEnv;
}

// class-validator coerces "" to 0 and passes @Min(0), so the blank-string guard must live here,
// where the raw string is read. A NaN pool timeout is falsy to pg, which silently reverts to
// wait-forever/never-reap — defeating the bound.
function intEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

export const databaseConfig = () => ({
  database: {
    url: process.env.DATABASE_URL,
    // The stack has no external pooler (a PgBouncer drop-in is owned by deploy), so this caps the
    // backend connections Postgres faces.
    poolMax: intEnv(process.env.DB_POOL_MAX, 10),
    // Fail an acquire after this long instead of pg's default of waiting forever, so a saturated
    // pool surfaces as a fast failure rather than an unbounded request backlog.
    connectionTimeoutMs: intEnv(process.env.DB_POOL_CONNECTION_TIMEOUT_MS, 5000),
    idleTimeoutMs: intEnv(process.env.DB_POOL_IDLE_TIMEOUT_MS, 10000),
  },
});
