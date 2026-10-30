import { Body, Controller, HttpCode, HttpStatus, Inject, Post, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { ArrayMaxSize, ArrayNotEmpty, IsArray } from 'class-validator';
import {
  API_INTERNAL_PREFIX,
  MAX_SKU_VIEW_BATCH,
  type SkuViewsBody,
  type SkuViewsResponse,
} from '@jcool/internal-contracts';
import { IsSnowflakeId } from '@jcool/platform/interface';
import { CallerTokenGuard, InternalCallers } from '@jcool/platform/internal-api';
import { Public } from '@jcool/platform/rbac';
import { ACCOUNT_THROTTLER, DEFAULT_THROTTLER } from '@jcool/platform/throttler';
import { PRODUCT_SKU_QUERY, type ProductSkuQuery } from '../../../application/public/product-sku-query.port';

export class SkuViewsDto implements SkuViewsBody {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(MAX_SKU_VIEW_BATCH)
  @IsSnowflakeId({ each: true })
  skuIds!: string[];
}

/**
 * The price and name checkout freezes into an order. Not filtered on status: an archived or draft SKU
 * comes back inactive and the order-service refuses it, by name.
 */
@ApiExcludeController()
@Public()
@SkipThrottle({ [DEFAULT_THROTTLER]: true, [ACCOUNT_THROTTLER]: true })
@UseGuards(CallerTokenGuard)
@InternalCallers('order-service')
@Controller(`${API_INTERNAL_PREFIX}/catalog`)
export class SkuViewsInternalController {
  constructor(@Inject(PRODUCT_SKU_QUERY) private readonly catalog: ProductSkuQuery) {}

  @Post('sku-views')
  @HttpCode(HttpStatus.OK)
  async views(@Body() { skuIds }: SkuViewsDto): Promise<SkuViewsResponse> {
    const views = await this.catalog.getSkuViews(skuIds);
    return {
      views: views.map(({ skuId, productName, unitPriceMinor, currency, isActive }) => ({
        skuId,
        productName,
        unitPriceMinor,
        currency,
        isActive,
      })),
    };
  }
}
