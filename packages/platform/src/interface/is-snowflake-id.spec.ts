import { BadRequestException } from '@nestjs/common';
import { validateSync } from 'class-validator';
import { IsSnowflakeId, ParseSnowflakeIdPipe } from './is-snowflake-id';

class Query {
  @IsSnowflakeId()
  userId!: string;
}

function errorsFor(userId: unknown): string[] {
  const query = Object.assign(new Query(), { userId });
  return validateSync(query).flatMap((error) => Object.values(error.constraints ?? {}));
}

const ID = '137465797020397179';
const NOT_IDS = ['0198d9c1-9800-8aab-9fff-ff0000000001', '', '0', '01', '-1', '1.5', 'abc', 42, null, undefined, {}];

describe('IsSnowflakeId', () => {
  it('accepts a routable id', () => {
    expect(errorsFor(ID)).toEqual([]);
  });

  it('rejects everything that is not one, including the uuids it replaces', () => {
    for (const value of NOT_IDS) {
      expect(errorsFor(value)).toEqual(['userId must be a routable id']);
    }
  });
});

describe('ParseSnowflakeIdPipe', () => {
  const pipe = new ParseSnowflakeIdPipe();

  it('passes a routable id through unchanged, as a string', () => {
    expect(pipe.transform(ID)).toBe(ID);
  });

  it('answers 400, not 500, on anything else', () => {
    for (const value of NOT_IDS) {
      expect(() => pipe.transform(value)).toThrow(BadRequestException);
    }
  });
});
