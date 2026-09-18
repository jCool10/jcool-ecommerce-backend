import type { DrizzleDBOf, DrizzleTxOf } from '@jcool/platform/database';
import type * as schema from './schema';

export {
  DRIZZLE,
  PG_POOL,
  type DrizzleDBOf,
  type DrizzleSchema,
  type DrizzleTxOf,
  type PgPool,
} from '@jcool/platform/database';

export type DrizzleDB = DrizzleDBOf<typeof schema>;

export type DrizzleTx = DrizzleTxOf<typeof schema>;
