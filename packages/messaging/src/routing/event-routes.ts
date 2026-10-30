import type { QueueSpec } from '../queue/queue-definition';

/** Every event type this process writes, and the queue it goes to. */
export type EventRoutes = Readonly<Record<string, QueueSpec>>;

export function routeOf(routes: EventRoutes, eventType: string): QueueSpec | undefined {
  return Object.hasOwn(routes, eventType) ? routes[eventType] : undefined;
}

/** Each queue once, by name; two specs under one name must agree on the dead-letter queue. */
export function destinationsOf(routes: EventRoutes): QueueSpec[] {
  const byName = new Map<string, QueueSpec>();
  for (const spec of Object.values(routes)) {
    const known = byName.get(spec.name);
    if (known && known.dlq !== spec.dlq) {
      throw new Error(`queue ${spec.name} is routed with two dead-letter queues: ${known.dlq} and ${spec.dlq}`);
    }
    byName.set(spec.name, known ?? spec);
  }
  return [...byName.values()];
}
