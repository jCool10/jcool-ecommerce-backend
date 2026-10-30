import { Controller, Get, Inject, Param, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { API_INTERNAL_PREFIX, type CartLinesResponse } from '@jcool/internal-contracts';
import { ParseSnowflakeIdPipe } from '@jcool/platform/interface';
import { CallerTokenGuard, InternalCallers } from '@jcool/platform/internal-api';
import { Public } from '@jcool/platform/rbac';
import { ACCOUNT_THROTTLER, DEFAULT_THROTTLER } from '@jcool/platform/throttler';
import { CART_SNAPSHOT, type CartSnapshotReader } from '../../application/public/cart-snapshot.port';

/**
 * What checkout reads before it writes anything. Unthrottled because every call comes from the
 * order-service's one address; `@Public` only lifts the user-token guard, the caller token replaces it.
 */
@ApiExcludeController()
@Public()
@SkipThrottle({ [DEFAULT_THROTTLER]: true, [ACCOUNT_THROTTLER]: true })
@UseGuards(CallerTokenGuard)
@InternalCallers('order-service')
@Controller(`${API_INTERNAL_PREFIX}/carts`)
export class CartLinesInternalController {
  constructor(@Inject(CART_SNAPSHOT) private readonly carts: CartSnapshotReader) {}

  // No cart is an empty one: a 404 here would read as a misrouted call to the caller.
  @Get(':userId/lines')
  async lines(@Param('userId', ParseSnowflakeIdPipe) userId: string): Promise<CartLinesResponse> {
    const lines = await this.carts.getLines(userId);
    return { lines: lines.map(({ skuId, quantity }) => ({ skuId, quantity })) };
  }
}
