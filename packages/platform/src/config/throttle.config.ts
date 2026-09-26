import { IsOptional } from 'class-validator';
import { IsStrictBoolean } from './strict-env-decorators';
import type { EnvBase } from './validate-env';

export function ThrottleEnv<TBase extends EnvBase>(Base: TBase) {
  class ThrottleEnv extends Base {
    @IsOptional()
    @IsStrictBoolean()
    THROTTLE_ENABLED?: string;
  }
  return ThrottleEnv;
}

export const throttleConfig = () => ({
  throttle: {
    // Kill-switch for load tests and e2e suites.
    enabled: process.env.THROTTLE_ENABLED !== 'false',
  },
});
