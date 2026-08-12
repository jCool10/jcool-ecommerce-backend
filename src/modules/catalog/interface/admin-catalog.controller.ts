import { Body, Controller, Delete, HttpCode, HttpStatus, Param, Patch, Post, Put } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Role } from '../../../shared/rbac/role.enum';
import { Roles } from '../../../shared/rbac/roles.decorator';
import { CatalogAdminService } from '../application/services/catalog-admin.service';
import {
  AdminCategoryResponseDto,
  AdminPriceResponseDto,
  AdminProductResponseDto,
  AdminSkuResponseDto,
} from './dto/admin-catalog.response.dto';
import { CreateCategoryDto } from './dto/create-category.dto';
import { CreateProductDto } from './dto/create-product.dto';
import { CreateSkuDto } from './dto/create-sku.dto';
import { SetPriceDto } from './dto/set-price.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { UpdateSkuDto } from './dto/update-sku.dto';

/**
 * Catalog admin write paths. Class-level `@Roles(Role.Admin)`: global guards
 * authenticate (401) then authorize (403 for a non-admin). Thin — validate,
 * call the service, map to a response DTO. DELETE is a soft-delete (archive) and
 * echoes the archived resource (200, not 204) so an admin sees the result.
 */
@ApiTags('admin-catalog')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Missing, expired, or invalid access token' })
@ApiForbiddenResponse({ description: 'Authenticated but not an admin' })
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
  async updateCategory(@Param('id') id: string, @Body() dto: UpdateCategoryDto): Promise<AdminCategoryResponseDto> {
    return AdminCategoryResponseDto.fromEntity(await this.admin.updateCategory(id, dto));
  }

  @Delete('categories/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: AdminCategoryResponseDto, description: 'Category archived (soft-delete)' })
  @ApiNotFoundResponse({ description: 'Category not found' })
  @ApiConflictResponse({ description: 'Category still has active products' })
  async deleteCategory(@Param('id') id: string): Promise<AdminCategoryResponseDto> {
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
  async updateProduct(@Param('id') id: string, @Body() dto: UpdateProductDto): Promise<AdminProductResponseDto> {
    return AdminProductResponseDto.fromEntity(await this.admin.updateProduct(id, dto));
  }

  @Delete('products/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: AdminProductResponseDto, description: 'Product archived (soft-delete)' })
  @ApiNotFoundResponse({ description: 'Product not found' })
  async deleteProduct(@Param('id') id: string): Promise<AdminProductResponseDto> {
    return AdminProductResponseDto.fromEntity(await this.admin.archiveProduct(id));
  }

  // ----- SKUs (product variants) -----

  @Post('products/:productId/skus')
  @ApiCreatedResponse({ type: AdminSkuResponseDto })
  @ApiNotFoundResponse({ description: 'Product not found' })
  @ApiConflictResponse({ description: 'SKU code already exists' })
  async createSku(@Param('productId') productId: string, @Body() dto: CreateSkuDto): Promise<AdminSkuResponseDto> {
    return AdminSkuResponseDto.fromEntity(await this.admin.createSku(productId, dto));
  }

  @Patch('skus/:id')
  @ApiOkResponse({ type: AdminSkuResponseDto })
  @ApiNotFoundResponse({ description: 'SKU not found' })
  @ApiConflictResponse({ description: 'SKU code already exists' })
  async updateSku(@Param('id') id: string, @Body() dto: UpdateSkuDto): Promise<AdminSkuResponseDto> {
    return AdminSkuResponseDto.fromEntity(await this.admin.updateSku(id, dto));
  }

  @Delete('skus/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: AdminSkuResponseDto, description: 'SKU archived (soft-delete)' })
  @ApiNotFoundResponse({ description: 'SKU not found' })
  async deleteSku(@Param('id') id: string): Promise<AdminSkuResponseDto> {
    return AdminSkuResponseDto.fromEntity(await this.admin.archiveSku(id));
  }

  // ----- Price -----

  @Put('skus/:skuId/price')
  @ApiOkResponse({ type: AdminPriceResponseDto, description: 'Price set or replaced (upsert per currency)' })
  @ApiNotFoundResponse({ description: 'SKU not found' })
  async setPrice(@Param('skuId') skuId: string, @Body() dto: SetPriceDto): Promise<AdminPriceResponseDto> {
    return AdminPriceResponseDto.fromEntity(await this.admin.setPrice(skuId, dto));
  }
}
