import { pgTable } from 'drizzle-orm/pg-core';
import { snowflakeId } from './snowflake-id.column';

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

  // A uuid, a row counter or a rounded number reaching a bigint column is a bug that would otherwise
  // only surface as a foreign key violation much later, or not at all.
  it('refuses a value that is not a routable id, in either direction', () => {
    for (const bad of ['0198d9c1-9800-8aab-9fff-ff0000000001', '0', '', '1.5', '-1', 137465797020397180]) {
      expect(() => column().mapToDriverValue(bad as never)).toThrow(TypeError);
      expect(() => column().mapFromDriverValue(bad as never)).toThrow(TypeError);
    }
  });
});
