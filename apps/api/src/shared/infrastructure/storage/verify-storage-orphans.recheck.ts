// Caps one re-check statement: it binds a parameter per candidate, and a bucket listing can hand
// over more candidates than Postgres accepts in a single statement.
export const RECHECK_CHUNK = 1000;

/**
 * The row snapshot predates the listing, and an upload inserts its row before it PUTs, so a key that
 * appeared mid-scan is absent from the snapshot while being a healthy PENDING asset. Re-reads just the
 * candidates, a chunk at a time, and returns the ones still unknown.
 */
export async function recheckCandidates(
  candidates: readonly string[],
  findKnown: (chunk: string[]) => Promise<string[]>,
  chunkSize = RECHECK_CHUNK,
): Promise<string[]> {
  const nowKnown = new Set<string>();
  for (let offset = 0; offset < candidates.length; offset += chunkSize) {
    for (const key of await findKnown(candidates.slice(offset, offset + chunkSize))) nowKnown.add(key);
  }
  return candidates.filter((key) => !nowKnown.has(key));
}
