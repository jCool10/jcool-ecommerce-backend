export const ID_GENERATOR = Symbol('ID_GENERATOR');

/**
 * Every id is minted by the id service. Rejects with a 503 when none can be had: there is no local
 * fallback, because a generator in this process would mint on a node id the fleet already holds.
 */
export interface IdGeneratorPort {
  mint(count?: number): Promise<string[]>;
}

export async function mintOne(ids: IdGeneratorPort): Promise<string> {
  const [id] = await ids.mint(1);
  return id;
}
