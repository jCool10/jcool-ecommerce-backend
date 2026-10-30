// Separate entries, so a service that only produces declares the outbox without an inbox table.
export { outbox } from './outbox/schema/outbox.schema';
export { inbox } from './inbox/schema/inbox.schema';
