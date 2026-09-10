import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '@shared/rbac';
import { CartService } from '../application/cart.service';
import { AddCartItemDto } from './dto/add-cart-item.dto';
import { CartResponseDto } from './dto/cart-response.dto';
import { UpdateCartItemDto } from './dto/update-cart-item.dto';

/**
 * The global JwtAuthGuard protects the whole controller — no `@Public()`. Cart is per-user: the id
 * comes from the token, never the request body, so one user can't touch another's cart.
 */
@ApiTags('cart')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Missing, expired, or invalid access token' })
@Controller('cart')
export class CartController {
  constructor(private readonly cart: CartService) {}

  @Get()
  @ApiOkResponse({ type: CartResponseDto })
  async view(@CurrentUser() user: AuthenticatedUser): Promise<CartResponseDto> {
    return CartResponseDto.fromView(await this.cart.view(user.userId));
  }

  @Post('items')
  @HttpCode(HttpStatus.OK) // Upsert into the existing cart resource → 200 + state, not 201.
  @ApiOkResponse({ type: CartResponseDto })
  @ApiNotFoundResponse({ description: 'SKU not found in catalog' })
  async addItem(@CurrentUser() user: AuthenticatedUser, @Body() dto: AddCartItemDto): Promise<CartResponseDto> {
    return CartResponseDto.fromView(await this.cart.addItem(user.userId, dto.skuId, dto.quantity));
  }

  @Patch('items/:skuId')
  @ApiParam({ name: 'skuId', format: 'uuid', description: 'Product-variant id (SKU)' })
  @ApiOkResponse({ type: CartResponseDto })
  @ApiNotFoundResponse({ description: 'SKU is not in the cart' })
  async setItemQuantity(
    @CurrentUser() user: AuthenticatedUser,
    @Param('skuId', ParseUUIDPipe) skuId: string,
    @Body() dto: UpdateCartItemDto,
  ): Promise<CartResponseDto> {
    return CartResponseDto.fromView(await this.cart.setItemQuantity(user.userId, skuId, dto.quantity));
  }

  @Delete('items/:skuId')
  @ApiParam({ name: 'skuId', format: 'uuid', description: 'Product-variant id (SKU)' })
  @ApiOkResponse({ type: CartResponseDto })
  async removeItem(
    @CurrentUser() user: AuthenticatedUser,
    @Param('skuId', ParseUUIDPipe) skuId: string,
  ): Promise<CartResponseDto> {
    return CartResponseDto.fromView(await this.cart.removeItem(user.userId, skuId));
  }

  @Delete()
  @ApiOkResponse({ type: CartResponseDto })
  async clear(@CurrentUser() user: AuthenticatedUser): Promise<CartResponseDto> {
    return CartResponseDto.fromView(await this.cart.clear(user.userId));
  }
}
