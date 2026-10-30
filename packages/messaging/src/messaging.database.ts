import type { DrizzleDBOf, DrizzleSchema } from '@jcool/platform/database';

/** The service's own Drizzle handle, read under the platform's `DRIZZLE` token; only the outbox and inbox are touched. */
export type MessagingDb = DrizzleDBOf<DrizzleSchema>;
