import type { ClientBase } from 'pg';
import { NODE_COUNT, SEQUENCE_BITS, decode } from '@jcool/id-codec';
import { SCRIPTS_NODE_ID, SnowflakeGenerator } from '@jcool/id-generator';
import { IdentityService } from '../src/modules/user/application/services/identity.service';

/**
 * Scripts mint in process, on the node reserved for them, so a seed run never collides with the id
 * service on the (ts, node, seq) triple. The key must be the service's own, or the rows route to
 * buckets their emails do not hash to.
 *
 * Only `withScriptsMintLock` builds one. The reserved node has no lease to carry a floor from one
 * run to the next, so it is read back from `users`: a run whose clock reads at or before an earlier
 * run's last millisecond would otherwise replay that run's ids.
 */
export async function scriptsIdentity(db: ClientBase): Promise<IdentityService> {
  const bucketKey = process.env.IDENTITY_BUCKET_KEY;
  if (!bucketKey) throw new Error('IDENTITY_BUCKET_KEY is required to mint user ids');
  const generator = SnowflakeGenerator.create({ nodeId: SCRIPTS_NODE_ID, floorMs: await lastScriptsMintMs(db) });
  return new IdentityService(
    { mint: (bucket, count = 1) => Promise.resolve(Array.from({ length: count }, () => generator.generate(bucket))) },
    bucketKey,
  );
}

// The timestamp is the id's top field, so the largest id on the node carries its newest timestamp.
async function lastScriptsMintMs(db: ClientBase): Promise<number | undefined> {
  const { rows } = await db.query<{ id: string | null }>(
    'SELECT max(id)::text AS id FROM users WHERE (id >> $1) & $2 = $3',
    [SEQUENCE_BITS, NODE_COUNT - 1, SCRIPTS_NODE_ID],
  );
  const id = rows[0]?.id;
  return id ? decode(id).tsMs : undefined;
}
