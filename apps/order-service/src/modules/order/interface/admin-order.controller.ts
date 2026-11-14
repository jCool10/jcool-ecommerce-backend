import { Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Res, UseFilters, UseGuards } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { ORDER_THROTTLE, UserThrottlerGuard } from '@jcool/platform/throttler';
import { CurrentUser, Role, Roles, type AuthenticatedUser } from '@jcool/platform/rbac';
import { ParseSnowflakeIdPipe } from '@jcool/platform/interface';
import { CancelOrderUseCase, RefundOrderUseCase } from '../application/use-cases';
import { OrderQueryService } from '../application/order-query.service';
import { ApiCheckoutUnavailableResponse, CheckoutUnavailableFilter } from './checkout-unavailable.filter';
import { ListAdminOrdersQueryDto } from './dto/list-orders-query.dto';
import { OrderResponseDto } from './dto/order-response.dto';
import { PaginatedOrdersResponseDto } from './dto/paginated-orders-response.dto';

// Force-cancel is the same `CancelOrderUseCase` as the buyer's, differing only in the audit reason
// it stamps, so an admin cannot reach an outcome a buyer's own cancel could not. Refund is admin-only.
@ApiTags('admin-orders')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Missing, expired, or invalid access token' })
@ApiForbiddenResponse({ description: 'Authenticated but not an admin' })
@ApiBadRequestResponse({ description: 'Malformed id or invalid query' })
@Roles(Role.Admin)
@UseFilters(CheckoutUnavailableFilter)
@Controller('admin/orders')
export class AdminOrderController {
  constructor(
    private readonly orderQueryService: OrderQueryService,
    private readonly cancelOrder: CancelOrderUseCase,
    private readonly refundOrder: RefundOrderUseCase,
  ) {}

  @Get()
  @ApiOkResponse({ type: PaginatedOrdersResponseDto })
  async list(@Query() query: ListAdminOrdersQueryDto): Promise<PaginatedOrdersResponseDto> {
    return PaginatedOrdersResponseDto.fromPage(
      await this.orderQueryService.adminList({
        page: query.page,
        pageSize: query.pageSize,
        status: query.status,
        userId: query.userId,
      }),
    );
  }

  @Get(':id')
  @ApiParam({ name: 'id', example: '137465797020397179' })
  @ApiOkResponse({ type: OrderResponseDto })
  @ApiNotFoundResponse({ description: 'Order not found' })
  async getOne(@Param('id', ParseSnowflakeIdPipe) id: string): Promise<OrderResponseDto> {
    return OrderResponseDto.fromView(await this.orderQueryService.adminGetOne(id));
  }

  @Post(':id/cancel')
  // Same per-user tier as the buyer's own cancel, for the same reason: each cancellation that lands
  // ends in an outbound call to close the checkout session. Being an admin does not make a loop on
  // this route cheaper for the gateway. The reads above are left alone — reads are cheap.
  @Throttle(ORDER_THROTTLE)
  @UseGuards(UserThrottlerGuard)
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'id', example: '137465797020397179' })
  @ApiOkResponse({ type: OrderResponseDto })
  @ApiNotFoundResponse({ description: 'Order not found' })
  @ApiConflictResponse({ description: 'Order has already settled and can no longer be cancelled' })
  @ApiCheckoutUnavailableResponse('The cancel could not be confirmed in time; retry')
  async cancel(@Param('id', ParseSnowflakeIdPipe) id: string): Promise<OrderResponseDto> {
    return OrderResponseDto.fromView(await this.cancelOrder.cancelAsAdmin(id));
  }

  // Throttled like cancel: each refund that lands ends in a provider refund and a restock.
  // `@Res()` without passthrough: Nest would otherwise reset a 202 to the route's default.
  @Post(':id/refund')
  @Throttle(ORDER_THROTTLE)
  @UseGuards(UserThrottlerGuard)
  @ApiParam({ name: 'id', example: '137465797020397179' })
  @ApiOkResponse({
    type: OrderResponseDto,
    description: 'Refunded: the money is back with the buyer, the stock restocked',
  })
  @ApiAcceptedResponse({
    type: OrderResponseDto,
    description:
      'The refund is still running, e.g. the provider holds it; it finishes on its own. The order reads REFUNDING, or still PAID when the run has not begun yet; calling again joins the same run',
  })
  @ApiNotFoundResponse({ description: 'Order not found' })
  @ApiConflictResponse({
    description:
      'Order is not paid, or the provider refused or failed the refund (`message: { code: "REFUND_FAILED", reason }`); the order stays PAID',
  })
  @ApiCheckoutUnavailableResponse('The refund could not be started in time and the order did not move; retry')
  async refund(
    @Param('id', ParseSnowflakeIdPipe) id: string,
    @CurrentUser() admin: AuthenticatedUser,
    @Res() res: Response,
  ): Promise<void> {
    const { order, settled } = await this.refundOrder.refundAsAdmin(id, admin.userId);
    res.status(settled ? HttpStatus.OK : HttpStatus.ACCEPTED).json(OrderResponseDto.fromView(order));
  }
}
