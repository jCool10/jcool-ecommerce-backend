import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { parseIntOr } from './env-parsers';
import { IsStrictBoolean, StrictInt } from './strict-env-decorators';
import type { EnvBase } from './validate-env';

export function ResilienceEnv<TBase extends EnvBase>(Base: TBase) {
  class ResilienceEnv extends Base {
    @IsOptional()
    @IsStrictBoolean()
    BREAKER_ENABLED?: string;

    // Min 100 so a typo cannot make every call time out before the downstream can possibly answer.
    @IsOptional()
    @StrictInt()
    @IsInt()
    @Min(100)
    BREAKER_TIMEOUT_MS?: number;

    // The share is compared strictly, so 100 never opens however many calls fail — capped at 99 so a
    // breaker that reads as configured cannot in fact be switched off. At the low end 1 opens on the
    // first failure once the window holds enough calls to count.
    @IsOptional()
    @StrictInt()
    @IsInt()
    @Min(1)
    @Max(99)
    BREAKER_ERROR_THRESHOLD_PCT?: number;

    // Min 100 keeps the open state from being so brief it never sheds any load.
    @IsOptional()
    @StrictInt()
    @IsInt()
    @Min(100)
    BREAKER_RESET_TIMEOUT_MS?: number;

    // Min 1000 — a window shorter than the calls it counts would forget each failure before the next
    // arrives.
    @IsOptional()
    @StrictInt()
    @IsInt()
    @Min(1000)
    BREAKER_ROLLING_WINDOW_MS?: number;

    // 0 and 1 behave identically — one failure is then the whole window — so the floor only rules out
    // the value that reads as "no gate at all".
    @IsOptional()
    @StrictInt()
    @IsInt()
    @Min(1)
    BREAKER_VOLUME_THRESHOLD?: number;
  }
  return ResilienceEnv;
}

export const resilienceConfig = () => ({
  resilience: {
    breaker: {
      // Off makes every guarded call a direct pass-through, dropping the timeout below with it, so
      // calls go back to waiting out the provider SDK's own far longer one.
      enabled: process.env.BREAKER_ENABLED !== 'false',
      // How long one call may run before it is abandoned and counted as a failure. Without it a
      // downstream that hangs rather than errors never trips anything: nothing ever fails, we just
      // stop having request slots. Shorter than the provider SDK's own timeout on purpose.
      timeoutMs: parseIntOr(process.env.BREAKER_TIMEOUT_MS, 3000),
      errorThresholdPercentage: parseIntOr(process.env.BREAKER_ERROR_THRESHOLD_PCT, 50),
      // Calls fail fast for this long before one trial call is allowed through.
      resetTimeoutMs: parseIntOr(process.env.BREAKER_RESET_TIMEOUT_MS, 10_000),
      // The breaker's memory: past this, errors are forgotten, so a slow trickle of failures never
      // accumulates into an open circuit.
      rollingWindowMs: parseIntOr(process.env.BREAKER_ROLLING_WINDOW_MS, 10_000),
      // Calls the window must hold before the share means anything, so one failure on a quiet route
      // cannot read as 100% and open the circuit. The flip side: below this rate it never opens.
      volumeThreshold: parseIntOr(process.env.BREAKER_VOLUME_THRESHOLD, 5),
    },
  },
});
