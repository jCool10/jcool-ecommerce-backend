/**
 * The node id is the only field separating two writers that mint in the same millisecond, so who
 * holds which id is decided here rather than at each construction site.
 *
 * The app holds one id for the whole fleet, so do not scale replicas until a lease hands each
 * process a distinct one — two replicas under one node id mint colliding triples. The standalone
 * seed scripts take a different id so a seed run alongside a live app is safe, and a future lease
 * must never hand `SCRIPTS_NODE_ID` to a replica. Two seed runs at once share it, though, and
 * collide with each other exactly as two replicas would — run them one at a time.
 */
export const APP_NODE_ID = 0;
export const SCRIPTS_NODE_ID = 1023;
