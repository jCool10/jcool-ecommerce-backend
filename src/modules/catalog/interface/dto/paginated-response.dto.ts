import { ApiProperty } from '@nestjs/swagger';
import { ProductResponseDto } from './product-response.dto';

// Paginated envelope for GET /products. Kept concrete (not generic) so Swagger
// emits a full schema without @ApiExtraModels — YAGNI until a second list endpoint.
export class PaginatedProductsResponseDto {
  @ApiProperty({ type: [ProductResponseDto] })
  items!: ProductResponseDto[];

  @ApiProperty({ example: 42, description: 'Total matching items' })
  total!: number;

  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 20 })
  pageSize!: number;

  @ApiProperty({ example: 3 })
  totalPages!: number;
}
