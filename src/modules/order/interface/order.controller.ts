import { Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '@modules/user/interface/decorators/current-user.decorator';
import { OrderService } from '../application/order.service';
import { OrderResponseDto } from './dto/order-response.dto';

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
  constructor(private readonly orders: OrderService) {}

  @Post()
  @ApiCreatedResponse({ type: OrderResponseDto })
  @ApiBadRequestResponse({ description: 'Cart is empty or contains an unpurchasable item' })
  async create(@CurrentUser() user: AuthenticatedUser): Promise<OrderResponseDto> {
    return OrderResponseDto.fromView(await this.orders.createFromCart(user.userId));
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
    return OrderResponseDto.fromView(await this.orders.place(user.userId, id));
  }

  @Get()
  @ApiOkResponse({ type: [OrderResponseDto] })
  async list(@CurrentUser() user: AuthenticatedUser): Promise<OrderResponseDto[]> {
    const views = await this.orders.list(user.userId);
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
    return OrderResponseDto.fromView(await this.orders.getOne(user.userId, id));
  }
}
