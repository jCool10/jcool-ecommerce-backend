import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiNotFoundResponse, ApiOkResponse, ApiParam, ApiTags } from '@nestjs/swagger';
import { Public } from '@shared/rbac';
import { GetProductDetailUseCase, ListProductsUseCase, SearchProductsUseCase } from '../application/use-cases';
import {
  ListProductsQueryDto,
  PaginatedProductsResponseDto,
  ProductResponseDto,
  ProductSearchResponseDto,
  SearchHitDto,
  SearchProductsQueryDto,
} from './dto';

/** `@Public()` is applied per handler, so any future write handler here defaults to protected. */
@ApiTags('catalog')
@Controller('products')
export class CatalogController {
  constructor(
    private readonly listProducts: ListProductsUseCase,
    private readonly getProductDetail: GetProductDetailUseCase,
    private readonly searchProducts: SearchProductsUseCase,
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
      items: result.items.map((product) => ProductResponseDto.fromEntity(product, result.imageUrls)),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
      totalPages: result.totalPages,
    };
  }

  // Declared before `:idOrSlug`: routes match in declaration order, so the param route below would
  // otherwise claim this path and answer with a 404 for a product slugged "search".
  @Public()
  @Get('search')
  @ApiOkResponse({ type: ProductSearchResponseDto })
  async search(@Query() query: SearchProductsQueryDto): Promise<ProductSearchResponseDto> {
    const result = await this.searchProducts.execute({
      q: query.q,
      page: query.page,
      pageSize: query.pageSize,
      categorySlug: query.categorySlug,
    });
    return {
      items: result.items.map((hit) => SearchHitDto.fromHit(hit)),
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
    const { product, imageUrls } = await this.getProductDetail.execute(idOrSlug);
    return ProductResponseDto.fromEntity(product, imageUrls);
  }
}
