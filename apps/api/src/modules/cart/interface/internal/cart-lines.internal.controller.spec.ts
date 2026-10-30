import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { ParseSnowflakeIdPipe } from '@jcool/platform/interface';
import type { CartSnapshotLine, CartSnapshotReader } from '../../application/public/cart-snapshot.port';
import { CartLinesInternalController } from './cart-lines.internal.controller';

const USER_ID = '137465797020397179';
const SKU_ID = '137465797020397180';

function build(lines: CartSnapshotLine[]) {
  const carts = { getLines: vi.fn<CartSnapshotReader['getLines']>().mockResolvedValue(lines) };
  return { controller: new CartLinesInternalController(carts), carts };
}

describe('CartLinesInternalController', () => {
  it.each(['42', 'not-an-id', ''])('refuses the user id %j in the path', (userId) => {
    expect(() => new ParseSnowflakeIdPipe().transform(userId)).toThrow(BadRequestException);
  });

  it('answers a user with no cart with no lines', async () => {
    const { controller, carts } = build([]);

    await expect(controller.lines(USER_ID)).resolves.toEqual({ lines: [] });
    expect(carts.getLines).toHaveBeenCalledWith(USER_ID);
  });

  it('answers only the SKU and quantity of each line', async () => {
    const line = { skuId: SKU_ID, quantity: 2, addedAt: new Date() } as CartSnapshotLine;
    const { controller } = build([line]);

    await expect(controller.lines(USER_ID)).resolves.toStrictEqual({ lines: [{ skuId: SKU_ID, quantity: 2 }] });
  });
});
