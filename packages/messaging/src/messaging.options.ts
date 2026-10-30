import type { InjectionToken, ModuleMetadata, Provider } from '@nestjs/common';
import type { QueueDefinition } from './queue/queue-definition';
import type { EventRoutes } from './routing/event-routes';

export interface MessagingModuleOptions {
  routes: EventRoutes;
  /** The queues this process consumes; a producer-only service passes none and runs no worker. */
  queues: QueueDefinition[];
  /** Resolves to `{ mint(count): Promise<string[]> }`; outbox and inbox ids come from it. */
  idGenerator: InjectionToken;
  /** Modules exporting the id generator and the dispatchers' dependencies. */
  imports?: ModuleMetadata['imports'];
  /** The dispatchers and whatever else only the messaging module needs. */
  providers?: Provider[];
}

export interface IdMinter {
  mint(count?: number): Promise<string[]>;
}

export async function mintOne(ids: IdMinter): Promise<string> {
  const [id] = await ids.mint(1);
  return id;
}
