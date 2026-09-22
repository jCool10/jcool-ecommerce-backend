import { NODE_COUNT } from '@jcool/id-codec';

/**
 * The node id is the only field separating two writers minting in the same millisecond, and the
 * layout carries no random bits to soften a collision. Seed scripts take their own id and must hold
 * the advisory lock that stops two of them running at once; nothing else may mint off a lease.
 */
export const APP_NODE_ID = 0;
export const SCRIPTS_NODE_ID = NODE_COUNT - 1;

/** The pool a lease hands out: every id except the two above, which no lease may ever grant. */
export const LEASED_NODE_MIN = APP_NODE_ID + 1;
export const LEASED_NODE_MAX = NODE_COUNT - 2;
