import { Controller, Get, Param, ParseUUIDPipe, Post, UseGuards, UseInterceptors } from '@nestjs/common';
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
import { CheckoutOrderUseCase } from '../application/use-cases';
import { OrderQueryService } from '../application/order-query.service';
import { OrderResponseDto } from './dto/order-response.dto';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import { RequireIdempotencyKeyGuard } from './require-idempotency-key.guard';

/**
 * Order endpoints for the authenticated user (global JwtAuthGuard protects the
 * whole controller — no `@Public()`). Thin: read the user, call the use case, map
 * to a DTO. Orders are per-user: the id comes from the token, and every read is
 * user-scoped, so one user can never see or place another's order. `POST /orders`
 * is the atomic checkout — snapshot cart, hold stock, go PENDING in one transaction.
 */
@ApiTags('orders')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Missing, expired, or invalid access token' })
@Controller('orders')
export class OrderController {
  constructor(
    private readonly checkout: CheckoutOrderUseCase,
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
  @ApiOkResponse({ type: [OrderResponseDto] })
  async list(@CurrentUser() user: AuthenticatedUser): Promise<OrderResponseDto[]> {
    const views = await this.orderQuery.list(user.userId);
    return views.map((view) => OrderResponseDto.fromView(view));
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
