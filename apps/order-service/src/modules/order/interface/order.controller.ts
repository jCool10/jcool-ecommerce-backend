import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseFilters,
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
import { ORDER_THROTTLE, PAYMENT_SESSION_THROTTLE, UserThrottlerGuard } from '@jcool/platform/throttler';
import { CurrentUser, type AuthenticatedUser } from '@jcool/platform/rbac';
import { ParseSnowflakeIdPipe } from '@jcool/platform/interface';
import { CancelOrderUseCase, CheckoutOrderUseCase, PayOrderUseCase } from '../application/use-cases';
import { OrderQueryService } from '../application/order-query.service';
import { ApiCheckoutUnavailableResponse, CheckoutUnavailableFilter } from './checkout-unavailable.filter';
import { CreatePaymentSessionResponseDto } from './dto/create-payment-session.response.dto';
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
@UseFilters(CheckoutUnavailableFilter)
@Controller('orders')
export class OrderController {
  constructor(
    private readonly checkoutOrder: CheckoutOrderUseCase,
    private readonly payOrder: PayOrderUseCase,
    private readonly cancelOrder: CancelOrderUseCase,
    private readonly orderQueryService: OrderQueryService,
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
  @ApiCheckoutUnavailableResponse('Stock could not be confirmed in time; retry with the same Idempotency-Key')
  async create(@CurrentUser() user: AuthenticatedUser): Promise<OrderResponseDto> {
    return OrderResponseDto.fromView(await this.checkoutOrder.execute(user.userId));
  }

  @Get()
  @ApiOkResponse({ type: PaginatedOrdersResponseDto })
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListOrdersQueryDto,
  ): Promise<PaginatedOrdersResponseDto> {
    return PaginatedOrdersResponseDto.fromPage(
      await this.orderQueryService.list(user.userId, { page: query.page, pageSize: query.pageSize }),
    );
  }

  @Post(':id/pay')
  // Each attempt can open a session at the gateway, so this is throttled per authenticated user as
  // well as per IP: one account can't turn a retry loop into outbound load we pay for.
  @Throttle(PAYMENT_SESSION_THROTTLE)
  @UseGuards(UserThrottlerGuard)
  @ApiParam({ name: 'id', example: '137465797020397179', description: 'Order id to pay' })
  // Also 201 when a still-open session is handed back. Responses as documented before the route
  // moved here, so the published contract does not change.
  @ApiCreatedResponse({ type: CreatePaymentSessionResponseDto })
  @ApiNotFoundResponse({ description: 'Order not found (or not owned by the caller)' })
  @ApiConflictResponse({ description: 'Order is not PENDING, or already has an active payment' })
  async pay(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseSnowflakeIdPipe) id: string,
  ): Promise<CreatePaymentSessionResponseDto> {
    return CreatePaymentSessionResponseDto.from(await this.payOrder.execute(id, user.userId));
  }

  @Post(':id/cancel')
  // Same per-user tier as checkout: each cancel ends in calls out to the gateway. No
  // Idempotency-Key — re-cancelling already answers 200, so there is nothing for a key to protect.
  @Throttle(ORDER_THROTTLE)
  @UseGuards(UserThrottlerGuard)
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'id', example: '137465797020397179' })
  @ApiOkResponse({ type: OrderResponseDto })
  @ApiNotFoundResponse({ description: 'Order not found, or not yours' })
  @ApiConflictResponse({ description: 'Order has already settled and can no longer be cancelled' })
  @ApiCheckoutUnavailableResponse('The cancel could not be confirmed in time; retry')
  async cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseSnowflakeIdPipe) id: string,
  ): Promise<OrderResponseDto> {
    return OrderResponseDto.fromView(await this.cancelOrder.cancelOwn(id, user.userId));
  }

  @Get(':id')
  @ApiParam({ name: 'id', example: '137465797020397179' })
  @ApiOkResponse({ type: OrderResponseDto })
  @ApiNotFoundResponse({ description: 'Order not found' })
  async getOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseSnowflakeIdPipe) id: string,
  ): Promise<OrderResponseDto> {
    return OrderResponseDto.fromView(await this.orderQueryService.getOne(user.userId, id));
  }
}
