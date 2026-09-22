import { sql } from 'drizzle-orm';
import { type AnyPgColumn, check, customType } from 'drizzle-orm/pg-core';
import { MIN_ROUTABLE_ID, isRoutableId } from '@jcool/id-codec';

/**
 * A routable id stored as Postgres `bigint` and carried through TypeScript as a decimal string.
 *
 * Drizzle's own `bigint` column offers `mode: 'number'`, which silently rounds past 2^53, and
 * `mode: 'bigint'`, whose values throw inside `JSON.stringify`. Neither can hold an id. node-postgres
 * already hands `int8` back as a string, so reads pass through untouched; `routableIdCheck` keeps
 * any other writer from storing what a write here would refuse.
 */
export const snowflakeId = (name: string) =>
  customType<{ data: string; driverParam: string }>({
    dataType: () => 'bigint',
    toDriver: (value) => {
      if (!isRoutableId(value)) {
        throw new TypeError(`Column ${name} refused ${String(value)}, which is not a routable id`);
      }
      return value;
    },
  })(name);

/** The database half of `snowflakeId`: a raw-SQL writer is held to the same lower bound. */
export const routableIdCheck = (name: string, column: AnyPgColumn) =>
  check(name, sql`${column} >= ${sql.raw(MIN_ROUTABLE_ID.toString())}`);
