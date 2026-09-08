import 'dotenv/config';
import { Pool } from 'pg';

// Postgres-side metric capture for the register-uniqueness benchmark; run after a seed and/or a k6
// load pass. pg_stat_statements is queried when present but is NOT enabled on the default docker
// image (it needs `shared_preload_libraries=pg_stat_statements` + a restart); everything else here
// reads always-on catalog views.

function bytesToMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

// Takes `SHOW`-formatted sizes only ("128MB", "2GB"), which always carry a unit. Do NOT feed
// `pg_settings.setting` here — that reports shared_buffers in 8kB pages, misread here as bytes.
function parseSharedBuffers(raw: string): number {
  const m = raw.trim().match(/^(\d+)\s*([kKmMgGtT]?B)?$/);
  if (!m) return NaN;
  const n = Number(m[1]);
  const unit = (m[2] ?? '').toUpperCase();
  const mult: Record<string, number> = { '': 1, B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
  return n * (mult[unit] ?? 1);
}

async function scalar<T = string>(pool: Pool, sql: string, params: unknown[] = []): Promise<T> {
  const res = await pool.query<Record<string, T>>(sql, params);
  return Object.values(res.rows[0] ?? {})[0];
}

// Counters arrive as strings: pg widens bigint rather than lose precision.
interface VacuumRow {
  n_live_tup: string;
  n_dead_tup: string;
  autovacuum_count: string;
  last_autovacuum: Date | null;
  last_autoanalyze: Date | null;
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required to capture DB metrics');

  const pool = new Pool({ connectionString, max: 2 });
  try {
    const rowCount = Number(await scalar<string>(pool, `SELECT count(*)::text FROM users`));
    const heapBytes = Number(await scalar<string>(pool, `SELECT pg_relation_size('users')::text`));
    const indexesBytes = Number(await scalar<string>(pool, `SELECT pg_indexes_size('users')::text`));
    const totalBytes = Number(await scalar<string>(pool, `SELECT pg_total_relation_size('users')::text`));

    const indexes = await pool.query<{ indexrelname: string; bytes: string }>(
      `SELECT indexrelname, pg_relation_size(indexrelid)::text AS bytes
         FROM pg_stat_user_indexes WHERE relname = 'users' ORDER BY indexrelname`,
    );
    const emailIndex = await pool.query<{ indexname: string; bytes: string }>(
      `SELECT i.indexrelname AS indexname, pg_relation_size(i.indexrelid)::text AS bytes
         FROM pg_stat_user_indexes i
         JOIN pg_index x ON x.indexrelid = i.indexrelid
        WHERE i.relname = 'users' AND x.indisunique
          AND pg_get_indexdef(i.indexrelid) ILIKE '%(email)%'
        ORDER BY i.indexrelname LIMIT 1`,
    );
    const emailIndexBytes = Number(emailIndex.rows[0]?.bytes ?? '0');
    const emailIndexName = emailIndex.rows[0]?.indexname ?? '(unique-email index not found)';

    const io = await pool.query<{ heap_hit: string; heap_read: string; idx_hit: string; idx_read: string }>(
      `SELECT coalesce(heap_blks_hit,0)::text AS heap_hit, coalesce(heap_blks_read,0)::text AS heap_read,
              coalesce(idx_blks_hit,0)::text  AS idx_hit,  coalesce(idx_blks_read,0)::text  AS idx_read
         FROM pg_statio_user_tables WHERE relname = 'users'`,
    );
    const ioRow = io.rows[0] ?? { heap_hit: '0', heap_read: '0', idx_hit: '0', idx_read: '0' };
    const hitRatio = (hit: number, read: number): string =>
      hit + read === 0 ? 'n/a (no reads yet)' : `${((hit / (hit + read)) * 100).toFixed(3)}%`;

    const vac = await pool.query<VacuumRow>(
      `SELECT n_live_tup, n_dead_tup, autovacuum_count, last_autovacuum, last_autoanalyze
         FROM pg_stat_user_tables WHERE relname = 'users'`,
    );
    const v = vac.rows.at(0);

    const sharedBuffersRaw = await scalar<string>(pool, `SHOW shared_buffers`);
    const sharedBuffersBytes = parseSharedBuffers(sharedBuffersRaw);
    const indexResident = emailIndexBytes < sharedBuffersBytes;

    let pgss = '';
    try {
      const rows = await pool.query<{ calls: string; mean_ms: string; query: string }>(
        `SELECT calls::text, round(mean_exec_time::numeric, 3)::text AS mean_ms, left(query, 70) AS query
           FROM pg_stat_statements
          WHERE query ILIKE '%insert into users%' OR query ILIKE '%from users%'
          ORDER BY calls DESC LIMIT 5`,
      );
      pgss = rows.rows.length
        ? rows.rows.map((r) => `  ${r.calls.padStart(9)} calls  ${r.mean_ms.padStart(9)} ms  ${r.query}`).join('\n')
        : '  (no matching statements yet)';
    } catch {
      pgss = '  UNAVAILABLE — pg_stat_statements not enabled (needs shared_preload_libraries + restart)';
    }

    const lines = [
      '=== users benchmark — DB metrics ===',
      `rows                 : ${rowCount.toLocaleString()}`,
      `heap size            : ${bytesToMb(heapBytes)}`,
      `all indexes size     : ${bytesToMb(indexesBytes)}`,
      `total relation size  : ${bytesToMb(totalBytes)}`,
      '',
      'indexes on users:',
      ...indexes.rows.map((r) => `  ${r.indexrelname.padEnd(28)} ${bytesToMb(Number(r.bytes))}`),
      '',
      `unique-email index   : ${emailIndexName} = ${bytesToMb(emailIndexBytes)}`,
      `shared_buffers       : ${sharedBuffersRaw} (${bytesToMb(sharedBuffersBytes)})`,
      `email idx RAM-resident? ${indexResident ? 'YES' : 'NO'} (coarse: idx bytes < shared_buffers, ignores OS cache + buffer contention; the index cache-hit% below is the authoritative signal)`,
      '',
      `heap cache-hit ratio : ${hitRatio(Number(ioRow.heap_hit), Number(ioRow.heap_read))}  (hit ${ioRow.heap_hit} / read ${ioRow.heap_read})`,
      `index cache-hit ratio: ${hitRatio(Number(ioRow.idx_hit), Number(ioRow.idx_read))}  (hit ${ioRow.idx_hit} / read ${ioRow.idx_read})`,
      '',
      `n_live_tup           : ${v?.n_live_tup ?? 'n/a'}`,
      `n_dead_tup           : ${v?.n_dead_tup ?? 'n/a'}`,
      `autovacuum_count     : ${v?.autovacuum_count ?? 'n/a'}`,
      `last_autovacuum      : ${v?.last_autovacuum?.toISOString() ?? 'never'}`,
      `last_autoanalyze     : ${v?.last_autoanalyze?.toISOString() ?? 'never'}`,
      '',
      'pg_stat_statements (insert/select on users):',
      pgss,
      '',
      '=== escalation gate reading ===',
      `B-bloom  (Phase 4): ${indexResident ? 'CLOSED' : 'watch'} — email index ${bytesToMb(emailIndexBytes)} vs shared_buffers ${bytesToMb(sharedBuffersBytes)}. ` +
        `Bloom only helps once the index stops being RAM-resident AND duplicate INSERT traffic is material.`,
      `B-partition (Phase 5): CLOSED at this scale — single-table maintenance triggers near ~300–500M rows / index > RAM (current rows ${rowCount.toLocaleString()}).`,
      `C-shard  (Phase 6): CLOSED at this scale — single-primary write/storage ceiling near ~1B+ rows.`,
    ];
    console.log(lines.join('\n'));
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  console.error('Metric capture failed:', error);
  process.exit(1);
});
