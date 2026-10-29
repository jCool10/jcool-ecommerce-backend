import type { Provider } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { MessagingModule } from './messaging.module';
import { DomainEventsWorker } from './queue/domain-events.worker';
import type { QueueDefinition } from './queue/queue-definition';
import { CATALOG, ORDERS, ROUTES } from './testing/messaging-fixtures';

const consumed = (spec: typeof ORDERS, consumer = spec.name): QueueDefinition => ({
  ...spec,
  consumer,
  dispatcher: Symbol(spec.name),
});

const providersOf = (queues: QueueDefinition[]): Provider[] =>
  MessagingModule.forRoot({ routes: ROUTES, queues, idGenerator: 'ids' }).providers ?? [];

describe('MessagingModule.forRoot', () => {
  it('runs no worker for a process that consumes nothing', () => {
    expect(providersOf([])).not.toContain(DomainEventsWorker);
    expect(providersOf([consumed(ORDERS)])).toContain(DomainEventsWorker);
  });

  it('refuses two consumed queues on one consumer group', () => {
    expect(() => providersOf([consumed(ORDERS, 'shared'), consumed(CATALOG, 'shared')])).toThrow(/consumer shared/);
  });
});
