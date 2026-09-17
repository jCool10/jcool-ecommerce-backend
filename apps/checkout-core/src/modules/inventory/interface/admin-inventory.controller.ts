import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
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
import { Role, Roles } from '@shared/rbac';
import { AdjustStockUseCase } from '../application/adjust-stock.use-case';
import { AdjustStockDto, SetStockDto, StockLevelResponseDto } from './dto';

/**
 * Inventory's only HTTP surface, and it is operator-facing: customers reach stock through Order,
 * which holds it inside the checkout transaction. Writes answer 409 rather than 500 when the result
 * would break a database invariant, because that is a fact about current stock, not a malformed
 * request.
 */
@ApiTags('admin-inventory')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Missing, expired, or invalid access token' })
@ApiForbiddenResponse({ description: 'Authenticated but not an admin' })
@ApiBadRequestResponse({ description: 'Malformed variant id (not a UUID) or invalid body' })
@Roles(Role.Admin)
@Controller('admin/inventory')
export class AdminInventoryController {
  constructor(private readonly stock: AdjustStockUseCase) {}

  @Get(':variantId')
  @ApiParam({ name: 'variantId', format: 'uuid' })
  @ApiOkResponse({ type: StockLevelResponseDto })
  @ApiNotFoundResponse({ description: 'This SKU has no stock level yet' })
  async getLevel(@Param('variantId', ParseUUIDPipe) variantId: string): Promise<StockLevelResponseDto> {
    return StockLevelResponseDto.fromView(variantId, await this.stock.getLevel(variantId));
  }

  @Put(':variantId')
  @ApiParam({ name: 'variantId', format: 'uuid' })
  @ApiOkResponse({ type: StockLevelResponseDto })
  @ApiConflictResponse({ description: 'The new level is below the quantity currently reserved' })
  async setOnHand(
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @Body() dto: SetStockDto,
  ): Promise<StockLevelResponseDto> {
    return StockLevelResponseDto.fromView(variantId, await this.stock.setOnHand(variantId, dto.quantityOnHand));
  }

  @Post(':variantId/adjust')
  // A POST that mutates an existing level rather than creating a resource — 200 with the new level,
  // not 201 with nothing to point at.
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'variantId', format: 'uuid' })
  @ApiOkResponse({ type: StockLevelResponseDto })
  @ApiNotFoundResponse({ description: 'This SKU has no stock level to adjust — set one first' })
  @ApiConflictResponse({ description: 'The adjustment would push stock below zero or below what is reserved' })
  async adjust(
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @Body() dto: AdjustStockDto,
  ): Promise<StockLevelResponseDto> {
    return StockLevelResponseDto.fromView(variantId, await this.stock.adjust(variantId, dto.delta));
  }
}
