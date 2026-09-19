import { IsNotEmpty, IsString } from 'class-validator';
import type { EnvBase } from './validate-env';

export function RedisEnv<TBase extends EnvBase>(Base: TBase) {
  class RedisEnv extends Base {
    @IsString()
    @IsNotEmpty()
    REDIS_URL!: string;
  }
  return RedisEnv;
}

export const redisConfig = () => ({
  redis: {
    url: process.env.REDIS_URL,
  },
});
