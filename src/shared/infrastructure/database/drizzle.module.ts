import { Global, Inject, Logger, Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';
import { DRIZZLE, PG_POOL, type DrizzleDB } from './drizzle.tokens';

/** Global Drizzle provider — one lazily-connecting pg Pool + `db` opened at startup and closed on shutdown, split into PG_POOL (internal, closed here) and DRIZZLE (exported). See docs/engineering-notes.md (Shared — Database (Drizzle + node-postgres)). */
@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Pool => {
        const pool = new Pool({
          connectionString: config.getOrThrow<string>('database.url'),
        });
        // Without an 'error' listener a dead idle client crashes the process;
        // log and let pg discard it (DB restart, failover, idle timeout).
        const logger = new Logger('DrizzleModule');
        pool.on('error', (err: Error) => {
          logger.error(`Unexpected idle pg client error: ${err.message}`, err.stack);
        });
        return pool;
      },
    },
    {
      provide: DRIZZLE,
      inject: [PG_POOL],
      useFactory: (pool: Pool): DrizzleDB => drizzle(pool, { schema }),
    },
  ],
  exports: [DRIZZLE],
})
export class DrizzleModule implements OnModuleDestroy {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
