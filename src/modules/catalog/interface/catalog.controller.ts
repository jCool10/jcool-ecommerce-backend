import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiNotFoundResponse, ApiOkResponse, ApiParam, ApiTags } from '@nestjs/swagger';
import { Public } from '@modules/user/interface/decorators';
import { GetProductDetailUseCase, ListProductsUseCase } from '../application/use-cases';
import { ListProductsQueryDto, PaginatedProductsResponseDto, ProductResponseDto } from './dto';

/** Catalog read paths — thin (validate, call a use case, map to a response DTO); `@Public()` is applied per handler so any future write handler here defaults to protected. */
@ApiTags('catalog')
@Controller('products')
export class CatalogController {
  constructor(
    private readonly listProducts: ListProductsUseCase,
    private readonly getProductDetail: GetProductDetailUseCase,
  ) {}

  @Public()
  @Get()
  @ApiOkResponse({ type: PaginatedProductsResponseDto })
  async list(@Query() query: ListProductsQueryDto): Promise<PaginatedProductsResponseDto> {
    const result = await this.listProducts.execute({
      page: query.page,
      pageSize: query.pageSize,
      categorySlug: query.categorySlug,
      q: query.q,
    });
    return {
      items: result.items.map((product) => ProductResponseDto.fromEntity(product)),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
      totalPages: result.totalPages,
    };
  }

  @Public()
  @Get(':idOrSlug')
  @ApiParam({ name: 'idOrSlug', description: 'Product id (UUID v7) or slug' })
  @ApiOkResponse({ type: ProductResponseDto })
  @ApiNotFoundResponse({ description: 'Product not found or not ACTIVE' })
  async detail(@Param('idOrSlug') idOrSlug: string): Promise<ProductResponseDto> {
    const product = await this.getProductDetail.execute(idOrSlug);
    return ProductResponseDto.fromEntity(product);
  }
}
