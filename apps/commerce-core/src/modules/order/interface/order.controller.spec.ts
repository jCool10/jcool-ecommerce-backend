import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser } from '@shared/rbac';
import type { CancelOrderUseCase, CheckoutOrderUseCase } from '../application/use-cases';
import type { OrderQueryService } from '../application/order-query.service';
import { OrderStatus } from '../domain/order-status';
import { OrderController } from './order.controller';

const VIEW = {
  id: 'order-1',
  status: OrderStatus.PENDING,
  currency: 'VND',
  totalAmountMinor: 200_000,
  placedAt: '2026-09-10T00:00:00.000Z',
  items: [],
};

const BUYER: AuthenticatedUser = {
  userId: 'u1',
  role: 'CUSTOMER',
  email: 'buyer@example.com',
  jti: 'j1',
  exp: 100,
};

function build() {
  const execute = vi.fn().mockResolvedValue(VIEW);
  const controller = new OrderController(
    { execute } as unknown as CheckoutOrderUseCase,
    {} as CancelOrderUseCase,
    {} as OrderQueryService,
  );
  return { controller, execute };
}

describe('OrderController.create', () => {
  it('snapshots the buyer address from the token', async () => {
    const { controller, execute } = build();

    await expect(controller.create(BUYER)).resolves.toMatchObject({ id: 'order-1' });

    expect(execute).toHaveBeenCalledWith('u1', 'buyer@example.com');
  });

  // Rollout guard: a token minted before the claim existed would snapshot nothing, and the column is
  // NOT NULL. One forced refresh beats a 500 window.
  it('rejects a token that carries no email claim, without opening a checkout', async () => {
    const { controller, execute } = build();
    const legacy = { ...BUYER, email: undefined } as unknown as AuthenticatedUser;

    await expect(controller.create(legacy)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(execute).not.toHaveBeenCalled();
  });
});
