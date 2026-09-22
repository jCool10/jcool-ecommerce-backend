import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

// TS2545: a mixin base has to accept `any[]`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type EnvBase = new (...args: any[]) => object;

export class EmptyEnv {}

export function validateEnv<T extends object>(schema: new () => T, config: Record<string, unknown>): T {
  const validated = plainToInstance(schema, config, {
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
