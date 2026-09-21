import { customType } from 'drizzle-orm/pg-core';
import { isRoutableId } from '@jcool/id-codec';

/**
 * A routable id stored as Postgres `bigint` and carried through TypeScript as a decimal string.
 *
 * Drizzle's own `bigint` column offers `mode: 'number'`, which silently rounds past 2^53, and
 * `mode: 'bigint'`, whose values throw inside `JSON.stringify`. Neither can hold an id. node-postgres
 * already hands `int8` back as a string, so both directions here are the identity function and the
 * digits never touch a `number`.
 */
export const snowflakeId = (name: string) =>
  customType<{ data: string; driverParam: string }>({
    dataType: () => 'bigint',
    fromDriver: (value) => {
      if (!isRoutableId(value)) {
        throw new TypeError(`Column ${name} holds ${String(value)}, which is not a routable id`);
      }
      return value;
    },
    toDriver: (value) => {
      if (!isRoutableId(value)) {
        throw new TypeError(`Column ${name} refused ${String(value)}, which is not a routable id`);
      }
      return value;
    },
  })(name);
