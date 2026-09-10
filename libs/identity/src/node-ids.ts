/**
 * The pool bound, and nothing else. There is no reserved id any more: node ids are leased per
 * service (`node_leases`), so every writer draws from its own `0..NODE_ID_MAX` space and a global
 * carve-out for scripts would protect nothing.
 *
 * The layout affords 1024 nodes; the top one is held back so a future "unleased/unknown" sentinel
 * has somewhere to live without narrowing a pool that is already in use.
 */
export const NODE_ID_MAX = 1022;

/**
 * The held-back id, and the only one no pool can ever hand out — pool size is capped at
 * `NODE_ID_MAX + 1`. It belongs to a writer that mints in the same process as a leased app and
 * cannot lease for itself: the e2e fixture, which mints user ids beside a running user-service
 * without a user row. Not a general escape hatch — anything that can lease, leases.
 */
export const UNLEASED_NODE_ID = NODE_ID_MAX + 1;
