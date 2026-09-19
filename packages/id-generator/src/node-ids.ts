import { NODE_COUNT } from '@jcool/id-codec';

/**
 * The node id is the only field separating two writers minting in the same millisecond. The api
 * holds one id for its whole fleet: DO NOT scale its replicas. Seed scripts take their own id, so a
 * seed run alongside a live app is safe — but two seed runs at once share it.
 */
export const APP_NODE_ID = 0;
export const SCRIPTS_NODE_ID = 1023;

/** The pool a lease hands out: every id except the two above, which no lease may ever grant. */
export const LEASED_NODE_MIN = APP_NODE_ID + 1;
export const LEASED_NODE_MAX = NODE_COUNT - 2;
