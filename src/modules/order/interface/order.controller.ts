import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
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
import { CurrentUser, type AuthenticatedUser } from '@modules/user/interface/decorators/current-user.decorator';
import { CreateOrderFromCartUseCase, PlaceOrderUseCase } from '../application/use-cases';
import { OrderQueryService } from '../application/order-query.service';
import { OrderResponseDto } from './dto/order-response.dto';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import { RequireIdempotencyKeyGuard } from './require-idempotency-key.guard';

/**
 * Order endpoints for the authenticated user (global JwtAuthGuard protects the
 * whole controller — no `@Public()`). Thin: read the user, call the service, map
 * to a DTO. Orders are per-user: the id comes from the token, and every read is
 * user-scoped, so one user can never see or place another's order.
 */
@ApiTags('orders')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Missing, expired, or invalid access token' })
@Controller('orders')
export class OrderController {
  constructor(
    private readonly createOrderFromCart: CreateOrderFromCartUseCase,
    private readonly placeOrder: PlaceOrderUseCase,
    private readonly orderQuery: OrderQueryService,
  ) {}

  @Post()
  @UseGuards(RequireIdempotencyKeyGuard)
  @UseInterceptors(IdempotencyInterceptor)
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description:
      'Client-generated UUID; retrying with the same value replays the first result instead of creating a second order.',
  })
  @ApiCreatedResponse({ type: OrderResponseDto })
  @ApiBadRequestResponse({ description: 'Missing/invalid Idempotency-Key, or empty/unpurchasable cart' })
  @ApiConflictResponse({ description: 'A request with this Idempotency-Key is already in progress' })
  @ApiUnprocessableEntityResponse({ description: 'Idempotency-Key reused with a different request' })
  async create(@CurrentUser() user: AuthenticatedUser): Promise<OrderResponseDto> {
    return OrderResponseDto.fromView(await this.createOrderFromCart.execute(user.userId));
  }

  @Post(':id/place')
  @HttpCode(HttpStatus.OK) // Status change on an existing resource → 200 + state, not 201.
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: OrderResponseDto })
  @ApiNotFoundResponse({ description: 'Order not found' })
  @ApiConflictResponse({ description: 'Order is not in a placeable (DRAFT) state' })
  async place(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<OrderResponseDto> {
    return OrderResponseDto.fromView(await this.placeOrder.execute(user.userId, id));
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
