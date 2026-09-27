export const ID_GENERATOR = Symbol('ID_GENERATOR');

/**
 * Every id is minted by the id service. Rejects with a 503 when none can be had: there is no local
 * fallback, because a generator in this process would mint on a node id the fleet already holds.
 */
export interface IdGeneratorPort {
  /** `count` ids, each carrying `bucket`. */
  mint(bucket: number, count?: number): Promise<string[]>;
}

/** For rows no user owns: catalog, stock, messaging, webhook events. */
export const UNOWNED_BUCKET = 0;

export async function mintOne(ids: IdGeneratorPort, bucket: number): Promise<string> {
  const [id] = await ids.mint(bucket, 1);
  return id;
}
