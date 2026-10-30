import { apiReadRoutes, cartLinesOf } from '@jcool/internal-contracts';
import type { CartSnapshotReaderPort, OrderCartLine } from '../application/ports/cart-snapshot.port';
import type { ApiInternalClient } from './api-internal.http-client';

/** The api answers 200 `{ lines: [] }` for a user with no cart, so any other answer is a failed read. */
export class CartSnapshotHttpAdapter implements CartSnapshotReaderPort {
  constructor(private readonly api: ApiInternalClient) {}

  getLines(userId: string): Promise<OrderCartLine[]> {
    return this.api.read(apiReadRoutes.cartLines(userId), undefined, cartLinesOf);
  }
}
