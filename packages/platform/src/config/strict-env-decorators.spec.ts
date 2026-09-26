import { IsInt, IsOptional } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { IsStrictBoolean, StrictInt } from './strict-env-decorators';
import { EmptyEnv, validateEnv } from './validate-env';

class IntEnv extends EmptyEnv {
  @IsOptional()
  @StrictInt()
  @IsInt()
  VALUE?: number;
}

class BoolEnv extends EmptyEnv {
  @IsOptional()
  @IsStrictBoolean()
  VALUE?: string;
}

const acceptsInt = (value: string): boolean => {
  try {
    validateEnv(IntEnv, { VALUE: value });
    return true;
  } catch {
    return false;
  }
};

const acceptsBool = (value: string): boolean => {
  try {
    validateEnv(BoolEnv, { VALUE: value });
    return true;
  } catch {
    return false;
  }
};

describe('StrictInt', () => {
  it('accepts a plain, optionally-signed decimal integer', () => {
    expect(['0', '123', '-5', '+7'].map(acceptsInt)).toEqual([true, true, true, true]);
    expect(validateEnv(IntEnv, { VALUE: '60000' }).VALUE).toBe(60_000);
  });

  // parseInt (every loader) stops at the first non-digit, so '6e4' reads as 6, not 60000 — the
  // exact drift this decorator exists to refuse at boot instead of at the loader.
  it('refuses scientific notation, hex, decimals and blanks that `Number()` would otherwise accept', () => {
    expect(['6e4', '0x10', '1e3', '12.5', '', '   ', 'abc', '1_000'].map(acceptsInt)).toEqual(
      new Array<boolean>(8).fill(false),
    );
  });

  // A redeclared field (id-service's DB_QUERY_TIMEOUT_MS) carries this decorator from both the
  // platform mixin and the subclass; class-transformer runs both, so the second pass must not
  // re-reject the number the first pass already produced.
  it('is idempotent when applied twice to the same value', () => {
    class TwiceEnv extends EmptyEnv {
      @IsOptional()
      @StrictInt()
      @StrictInt()
      @IsInt()
      VALUE?: number;
    }

    expect(validateEnv(TwiceEnv, { VALUE: '2000' }).VALUE).toBe(2000);
  });
});

describe('IsStrictBoolean', () => {
  it("accepts only exactly 'true' or 'false'", () => {
    expect(['true', 'false'].map(acceptsBool)).toEqual([true, true]);
  });

  // Loaders compare with `=== 'true'` or `!== 'false'`, so '0', '1' and any other spelling must fail
  // validation instead of silently loading as the opposite of what they validated as.
  it("refuses '0', '1' and every other spelling", () => {
    expect(['0', '1', 'TRUE', 'False', 'yes', ''].map(acceptsBool)).toEqual(new Array<boolean>(6).fill(false));
  });
});
