import { Transform } from 'class-transformer';
import { ValidateBy, buildMessage, type ValidationOptions } from 'class-validator';

// Loaders read integers with parseInt, so anything Number() alone would accept ('6e4', '0x10') must
// fail validation rather than load as a different value.
const STRICT_DECIMAL_INT = /^[+-]?\d+$/;

/** Use ahead of `@IsInt()`. A number passes through: a redeclared field runs this transform twice. */
export function StrictInt(): PropertyDecorator {
  return Transform(({ value }: { value: unknown }): number => {
    if (typeof value === 'number') return value;
    return typeof value === 'string' && STRICT_DECIMAL_INT.test(value.trim()) ? Number(value) : NaN;
  });
}

export const IS_STRICT_BOOLEAN = 'isStrictBoolean';

/** Loaders compare against the literals 'true'/'false', so '0'/'1' must not validate. */
export function IsStrictBoolean(validationOptions?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: IS_STRICT_BOOLEAN,
      validator: {
        validate: (value: unknown): boolean => value === 'true' || value === 'false',
        defaultMessage: buildMessage(
          (prefix) => `${prefix}$property must be exactly 'true' or 'false'`,
          validationOptions,
        ),
      },
    },
    validationOptions,
  );
}
