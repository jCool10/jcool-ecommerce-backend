import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Role, Roles } from '@shared/rbac';
import { CatalogAdminService } from '../application/services/catalog-admin.service';
import {
  AdminCategoryResponseDto,
  AdminPriceResponseDto,
  AdminProductImageResponseDto,
  AdminProductResponseDto,
  AdminSkuResponseDto,
  AttachProductImageDto,
  CreateCategoryDto,
  CreateProductDto,
  CreateSkuDto,
  ReorderProductImagesDto,
  SetPriceDto,
  UpdateCategoryDto,
  UpdateProductDto,
  UpdateSkuDto,
} from './dto';

/** Catalog admin write paths — class-level `@Roles(Role.Admin)` (global guards authenticate 401 then authorize 403), thin (validate, call the service, map to a DTO); DELETE is a soft-delete that echoes the archived resource (200, not 204). */
@ApiTags('admin-catalog')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Missing, expired, or invalid access token' })
@ApiForbiddenResponse({ description: 'Authenticated but not an admin' })
@ApiBadRequestResponse({ description: 'Malformed id (not a UUID) or invalid body' })
@Roles(Role.Admin)
@Controller('admin')
export class AdminCatalogController {
  constructor(private readonly admin: CatalogAdminService) {}

  // ----- Categories -----

  @Post('categories')
  @ApiCreatedResponse({ type: AdminCategoryResponseDto })
  @ApiConflictResponse({ description: 'Slug already exists' })
  async createCategory(@Body() dto: CreateCategoryDto): Promise<AdminCategoryResponseDto> {
    return AdminCategoryResponseDto.fromEntity(await this.admin.createCategory(dto));
  }

  @Patch('categories/:id')
  @ApiOkResponse({ type: AdminCategoryResponseDto })
  @ApiNotFoundResponse({ description: 'Category not found' })
  @ApiConflictResponse({ description: 'Slug already exists' })
  async updateCategory(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCategoryDto,
  ): Promise<AdminCategoryResponseDto> {
    return AdminCategoryResponseDto.fromEntity(await this.admin.updateCategory(id, dto));
  }

  @Delete('categories/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: AdminCategoryResponseDto, description: 'Category archived (soft-delete)' })
  @ApiNotFoundResponse({ description: 'Category not found' })
  @ApiConflictResponse({ description: 'Category still has active products' })
  async deleteCategory(@Param('id', ParseUUIDPipe) id: string): Promise<AdminCategoryResponseDto> {
    return AdminCategoryResponseDto.fromEntity(await this.admin.archiveCategory(id));
  }

  // ----- Products -----

  @Post('products')
  @ApiCreatedResponse({ type: AdminProductResponseDto })
  @ApiNotFoundResponse({ description: 'Category not found' })
  @ApiConflictResponse({ description: 'Slug already exists' })
  async createProduct(@Body() dto: CreateProductDto): Promise<AdminProductResponseDto> {
    return AdminProductResponseDto.fromEntity(await this.admin.createProduct(dto));
  }

  @Patch('products/:id')
  @ApiOkResponse({ type: AdminProductResponseDto })
  @ApiNotFoundResponse({ description: 'Product or referenced category not found' })
  @ApiConflictResponse({ description: 'Slug already exists' })
  async updateProduct(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProductDto,
  ): Promise<AdminProductResponseDto> {
    return AdminProductResponseDto.fromEntity(await this.admin.updateProduct(id, dto));
  }

  @Delete('products/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: AdminProductResponseDto, description: 'Product archived (soft-delete)' })
  @ApiNotFoundResponse({ description: 'Product not found' })
  async deleteProduct(@Param('id', ParseUUIDPipe) id: string): Promise<AdminProductResponseDto> {
    return AdminProductResponseDto.fromEntity(await this.admin.archiveProduct(id));
  }

  // ----- SKUs (product variants) -----

  @Post('products/:productId/skus')
  @ApiCreatedResponse({ type: AdminSkuResponseDto })
  @ApiNotFoundResponse({ description: 'Product not found' })
  @ApiConflictResponse({ description: 'SKU code already exists' })
  async createSku(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() dto: CreateSkuDto,
  ): Promise<AdminSkuResponseDto> {
    return AdminSkuResponseDto.fromEntity(await this.admin.createSku(productId, dto));
  }

  @Patch('skus/:id')
  @ApiOkResponse({ type: AdminSkuResponseDto })
  @ApiNotFoundResponse({ description: 'SKU not found' })
  @ApiConflictResponse({ description: 'SKU code already exists' })
  async updateSku(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateSkuDto): Promise<AdminSkuResponseDto> {
    return AdminSkuResponseDto.fromEntity(await this.admin.updateSku(id, dto));
  }

  @Delete('skus/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: AdminSkuResponseDto, description: 'SKU archived (soft-delete)' })
  @ApiNotFoundResponse({ description: 'SKU not found' })
  async deleteSku(@Param('id', ParseUUIDPipe) id: string): Promise<AdminSkuResponseDto> {
    return AdminSkuResponseDto.fromEntity(await this.admin.archiveSku(id));
  }

  // ----- Product images -----

  @Get('products/:productId/images')
  @ApiOkResponse({ type: [AdminProductImageResponseDto] })
  @ApiNotFoundResponse({ description: 'Product not found' })
  async listProductImages(
    @Param('productId', ParseUUIDPipe) productId: string,
  ): Promise<AdminProductImageResponseDto[]> {
    const images = await this.admin.listProductImages(productId);
    return images.map((image) => AdminProductImageResponseDto.fromEntity(image));
  }

  @Post('products/:productId/images')
  @ApiCreatedResponse({ type: AdminProductImageResponseDto })
  @ApiNotFoundResponse({ description: 'Product not found' })
  @ApiConflictResponse({ description: 'Asset already attached, or not in a state that can be attached' })
  async attachProductImage(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() dto: AttachProductImageDto,
  ): Promise<AdminProductImageResponseDto> {
    return AdminProductImageResponseDto.fromEntity(await this.admin.attachProductImage(productId, dto));
  }

  // Unlike the archives above, this one is a hard delete of the link row: the asset itself survives
  // as DETACHED until a sweep reclaims it.
  @Delete('products/:productId/images/:imageId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse({ description: 'Image detached; the asset becomes reclaimable' })
  @ApiNotFoundResponse({ description: 'Image not found on that product' })
  async detachProductImage(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Param('imageId', ParseUUIDPipe) imageId: string,
  ): Promise<void> {
    await this.admin.detachProductImage(productId, imageId);
  }

  @Patch('products/:productId/images')
  @ApiOkResponse({ type: [AdminProductImageResponseDto], description: 'Images in their new order' })
  @ApiNotFoundResponse({ description: 'Product not found' })
  @ApiConflictResponse({ description: 'The order must list every image on the product exactly once' })
  async reorderProductImages(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() dto: ReorderProductImagesDto,
  ): Promise<AdminProductImageResponseDto[]> {
    const images = await this.admin.reorderProductImages(productId, dto.imageIds);
    return images.map((image) => AdminProductImageResponseDto.fromEntity(image));
  }

  // ----- Price -----

  @Put('skus/:skuId/price')
  @ApiOkResponse({ type: AdminPriceResponseDto, description: 'Price set or replaced (upsert per currency)' })
  @ApiNotFoundResponse({ description: 'SKU not found' })
  async setPrice(
    @Param('skuId', ParseUUIDPipe) skuId: string,
    @Body() dto: SetPriceDto,
  ): Promise<AdminPriceResponseDto> {
    return AdminPriceResponseDto.fromEntity(await this.admin.setPrice(skuId, dto));
  }
}
