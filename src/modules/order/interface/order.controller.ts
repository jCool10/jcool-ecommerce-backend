import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ORDER_THROTTLE, UserThrottlerGuard } from '@shared/infrastructure/throttler';
import { CurrentUser, type AuthenticatedUser } from '@shared/rbac';
import { CancelOrderUseCase, CheckoutOrderUseCase } from '../application/use-cases';
import { OrderQueryService } from '../application/order-query.service';
import { ListOrdersQueryDto } from './dto/list-orders-query.dto';
import { OrderResponseDto } from './dto/order-response.dto';
import { PaginatedOrdersResponseDto } from './dto/paginated-orders-response.dto';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import { RequireIdempotencyKeyGuard } from './require-idempotency-key.guard';

// The global JwtAuthGuard protects every route here — nothing is marked `@Public()`, and the user
// id comes from the token, never from the request.
@ApiTags('orders')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Missing, expired, or invalid access token' })
@Controller('orders')
export class OrderController {
  constructor(
    private readonly checkout: CheckoutOrderUseCase,
    private readonly cancelOrder: CancelOrderUseCase,
    private readonly orderQuery: OrderQueryService,
  ) {}

  @Post()
  // The per-user tier needs the id from the token, so it can only run here, after the global
  // authentication guard — a 429 still costs the token checks. Listed ahead of the idempotency
  // guard so a caller hammering checkout is shed before a key is claimed for it.
  @Throttle(ORDER_THROTTLE)
  @UseGuards(UserThrottlerGuard, RequireIdempotencyKeyGuard)
  @UseInterceptors(IdempotencyInterceptor)
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description:
      'Client-generated UUID; retrying with the same value replays the first result instead of creating a second order.',
  })
  @ApiCreatedResponse({ type: OrderResponseDto })
  @ApiBadRequestResponse({ description: 'Missing/invalid Idempotency-Key, or empty/unpurchasable cart' })
  @ApiConflictResponse({ description: 'Idempotency-Key already in progress, or insufficient stock' })
  @ApiUnprocessableEntityResponse({ description: 'Idempotency-Key reused with a different request' })
  async create(@CurrentUser() user: AuthenticatedUser): Promise<OrderResponseDto> {
    return OrderResponseDto.fromView(await this.checkout.execute(user.userId));
  }

  @Get()
  @ApiOkResponse({ type: PaginatedOrdersResponseDto })
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListOrdersQueryDto,
  ): Promise<PaginatedOrdersResponseDto> {
    return PaginatedOrdersResponseDto.fromPage(
      await this.orderQuery.list(user.userId, { page: query.page, pageSize: query.pageSize }),
    );
  }

  @Post(':id/cancel')
  // Same per-user tier as checkout: each cancel ends in a queued call out to the gateway. No
  // Idempotency-Key — re-cancelling already answers 200, so there is nothing for a key to protect.
  @Throttle(ORDER_THROTTLE)
  @UseGuards(UserThrottlerGuard)
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: OrderResponseDto })
  @ApiNotFoundResponse({ description: 'Order not found, or not yours' })
  @ApiConflictResponse({ description: 'Order has already settled and can no longer be cancelled' })
  async cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<OrderResponseDto> {
    return OrderResponseDto.fromView(await this.cancelOrder.cancelOwn(id, user.userId));
  }

  @Get(':id')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: OrderResponseDto })
  @ApiNotFoundResponse({ description: 'Order not found' })
  async getOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<OrderResponseDto> {
    return OrderResponseDto.fromView(await this.orderQuery.getOne(user.userId, id));
  }
}
