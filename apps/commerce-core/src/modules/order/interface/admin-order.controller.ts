import { Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import {
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
import { ORDER_THROTTLE, UserThrottlerGuard } from '@shared/infrastructure/throttler';
import { Role, Roles } from '@shared/rbac';
import { CancelOrderUseCase } from '../application/use-cases';
import { OrderQueryService } from '../application/order-query.service';
import { ListAdminOrdersQueryDto } from './dto/list-orders-query.dto';
import { OrderResponseDto } from './dto/order-response.dto';
import { PaginatedOrdersResponseDto } from './dto/paginated-orders-response.dto';

// Force-cancel is the same `CancelOrderUseCase` as the buyer's, differing only in the audit reason
// it stamps, so an admin cannot reach an outcome a buyer's own cancel could not.
@ApiTags('admin-orders')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Missing, expired, or invalid access token' })
@ApiForbiddenResponse({ description: 'Authenticated but not an admin' })
@ApiBadRequestResponse({ description: 'Malformed id (not a UUID) or invalid query' })
@Roles(Role.Admin)
@Controller('admin/orders')
export class AdminOrderController {
  constructor(
    private readonly orderQuery: OrderQueryService,
    private readonly cancelOrder: CancelOrderUseCase,
  ) {}

  @Get()
  @ApiOkResponse({ type: PaginatedOrdersResponseDto })
  async list(@Query() query: ListAdminOrdersQueryDto): Promise<PaginatedOrdersResponseDto> {
    return PaginatedOrdersResponseDto.fromPage(
      await this.orderQuery.adminList({
        page: query.page,
        pageSize: query.pageSize,
        status: query.status,
        userId: query.userId,
      }),
    );
  }

  @Get(':id')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: OrderResponseDto })
  @ApiNotFoundResponse({ description: 'Order not found' })
  async getOne(@Param('id', ParseUUIDPipe) id: string): Promise<OrderResponseDto> {
    return OrderResponseDto.fromView(await this.orderQuery.adminGetOne(id));
  }

  @Post(':id/cancel')
  // Same per-user tier as the buyer's own cancel, for the same reason: each cancellation that lands
  // ends in an outbound call to close the checkout session. Being an admin does not make a loop on
  // this route cheaper for the gateway. The reads above are left alone — reads are cheap.
  @Throttle(ORDER_THROTTLE)
  @UseGuards(UserThrottlerGuard)
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: OrderResponseDto })
  @ApiNotFoundResponse({ description: 'Order not found' })
  @ApiConflictResponse({ description: 'Order has already settled and can no longer be cancelled' })
  async cancel(@Param('id', ParseUUIDPipe) id: string): Promise<OrderResponseDto> {
    return OrderResponseDto.fromView(await this.cancelOrder.cancelAsAdmin(id));
  }
}
