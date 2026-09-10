import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UserAppModule } from '@user/app.module';
import { OUTBOX_WRITER } from '@shared/messaging';
import { QUEUE_CONNECTION, QUEUE_DOMAIN_EVENTS } from '@shared/messaging/queue/queue.constants';
import { DomainEventProcessor } from '@shared/messaging/queue/domain-event.processor';
import { RedisService } from '@shared/infrastructure/redis';
import { createUserApp } from '../setup/test-app.factory';

interface DynamicModuleLike {
  module: unknown;
  imports?: unknown[];
}

const isDynamic = (candidate: unknown): candidate is DynamicModuleLike =>
  typeof candidate === 'object' && candidate !== null && 'module' in candidate;

/** Every module a boot would instantiate, static and dynamic alike. */
function reachableModuleNames(root: unknown): Set<string> {
  const seen = new Set<string>();
  const queue: unknown[] = [root];

  while (queue.length > 0) {
    const current = queue.pop();
    const target = isDynamic(current) ? current.module : current;
    if (typeof target !== 'function' || seen.has(target.name)) continue;
    seen.add(target.name);
    queue.push(
      ...((Reflect.getMetadata('imports', target) as unknown[] | undefined) ?? []),
      ...(isDynamic(current) ? (current.imports ?? []) : []),
    );
  }

  return seen;
}

/**
 * user-service emits no domain events, consumes none, and has no outbox to relay. Wiring
 * MessagingModule here would open a BullMQ connection and start a relay timer at boot — against a
 * database with no `outbox` table, and over a channel the split exists to keep empty.
 */
describe('user-service boundaries (integration)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createUserApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('wires no messaging module at all', () => {
    const modules = reachableModuleNames(UserAppModule);

    expect(modules).not.toContain('MessagingModule');
    expect([...modules].filter((name) => /Bull|Queue|Outbox|Inbox/.test(name))).toEqual([]);
    // The other direction of the same claim: nothing of commerce-core is reachable either.
    expect([...modules].filter((name) => /Catalog|Cart|Order|Payment|Inventory|Media|Search/.test(name))).toEqual([]);
  });

  // Resolved off the running container, not the metadata: a provider registered by some other route
  // — a stray @Global module, a copied provider array — would satisfy the graph check above.
  it.each([
    ['the outbox writer', OUTBOX_WRITER],
    ['a queue connection', QUEUE_CONNECTION],
    ['the domain-events queue', QUEUE_DOMAIN_EVENTS],
    ['the domain-event consumer', DomainEventProcessor],
  ])('has no %s', (_label, token) => {
    expect(() => app.get(token as never)).toThrow();
  });

  // BullMQ writes its keyspace on the first queue construction, so an empty prefix is proof no queue
  // was ever built — including one built and immediately idle.
  it('leaves no BullMQ keys in Redis after a full boot', async () => {
    const keys = await app
      .get(RedisService)
      .getClient()
      .keys(`${process.env.QUEUE_PREFIX ?? 'bull'}*`);

    expect(keys).toEqual([]);
  });
});
