export const ID_GENERATOR = Symbol('ID_GENERATOR');

/**
 * Every id here is minted by the id service. Rejects when none can be had: there is no local
 * fallback, because a second generator on this process's node would collide with the fleet's.
 */
export interface IdGeneratorPort {
  /** `count` ids, each carrying `bucket`. */
  mint(bucket: number, count?: number): Promise<string[]>;
}
