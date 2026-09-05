/**
 * The node id is the only field separating two writers minting in the same millisecond.
 *
 * The app holds one id for the whole fleet: DO NOT scale replicas until a lease hands each process a
 * distinct one, or they mint colliding triples. Seed scripts take their own id so a seed run
 * alongside a live app is safe — but two seed runs at once share it, so run them one at a time. A
 * future lease must never hand `SCRIPTS_NODE_ID` to a replica.
 */
export const APP_NODE_ID = 0;
export const SCRIPTS_NODE_ID = 1023;
