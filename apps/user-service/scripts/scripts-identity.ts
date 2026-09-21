import { SCRIPTS_NODE_ID, SnowflakeGenerator } from '@jcool/id-generator';
import { IdentityService } from '../src/modules/user/application/services/identity.service';

/**
 * Scripts mint in process, on the node reserved for them, so a seed run never collides with the id
 * service on the (ts, node, seq) triple. Build one per run: a second generator repeats the sequence.
 * The key must be the service's own, or the rows route to buckets their emails do not hash to.
 *
 * Call this inside `withScriptsMintLock`. Two script runs share the one reserved node id, and the
 * layout has no random bits left to keep their ids apart.
 */
export function scriptsIdentity(): IdentityService {
  const bucketKey = process.env.IDENTITY_BUCKET_KEY;
  if (!bucketKey) throw new Error('IDENTITY_BUCKET_KEY is required to mint user ids');
  const generator = SnowflakeGenerator.create({ nodeId: SCRIPTS_NODE_ID });
  return new IdentityService(
    { mint: (bucket, count = 1) => Promise.resolve(Array.from({ length: count }, () => generator.generate(bucket))) },
    bucketKey,
  );
}
