import { PgDialect, getTableConfig, pgTable } from 'drizzle-orm/pg-core';
import { routableIdCheck, snowflakeId } from './snowflake-id.column';

const ID = '137465797020397179';
const MAX_ID = '9223372036854775807';

const rows = pgTable('rows', { userId: snowflakeId('user_id') });

function column() {
  return rows.userId;
}

describe('snowflakeId column', () => {
  it('declares a postgres bigint', () => {
    expect(column().getSQLType()).toBe('bigint');
  });

  it('keeps every digit on the way out of the driver', () => {
    // node-postgres hands int8 back as a string; a `number` here would drop the low digits.
    expect(column().mapFromDriverValue(ID)).toBe(ID);
    expect(column().mapFromDriverValue(MAX_ID)).toBe(MAX_ID);
  });

  it('keeps every digit on the way in', () => {
    expect(column().mapToDriverValue(ID)).toBe(ID);
    expect(column().mapToDriverValue(MAX_ID)).toBe(MAX_ID);
  });

  it('refuses to write a value that is not a routable id', () => {
    for (const bad of ['0198d9c1-9800-8aab-9fff-ff0000000001', '0', '4194303', '', '1.5', '-1', 137465797020397180]) {
      expect(() => column().mapToDriverValue(bad as never)).toThrow(TypeError);
    }
  });

  // The database CHECK keeps a bad value out, so a read never has a reason to throw.
  it('reads whatever the driver returns without validating it', () => {
    expect(column().mapFromDriverValue('4194303')).toBe('4194303');
  });
});

describe('routableIdCheck', () => {
  it('holds the column to the smallest routable id', () => {
    const table = pgTable('checked', { userId: snowflakeId('user_id') }, (t) => [
      routableIdCheck('ck_checked_user_id_routable', t.userId),
    ]);
    const [constraint] = getTableConfig(table).checks;
    const rendered = new PgDialect().sqlToQuery(constraint.value);

    expect(constraint.name).toBe('ck_checked_user_id_routable');
    expect(rendered.sql).toBe('"checked"."user_id" >= 4194304');
    expect(rendered.params).toEqual([]);
  });
});
