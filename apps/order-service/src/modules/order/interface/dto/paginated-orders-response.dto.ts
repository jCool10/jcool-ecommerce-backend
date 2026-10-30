import { ApiProperty } from '@nestjs/swagger';
import type { OrderPageView } from '../../application/order-query.service';
import { OrderResponseDto } from './order-response.dto';

// Concrete rather than generic so Swagger emits a full schema without @ApiExtraModels.
export class PaginatedOrdersResponseDto {
  @ApiProperty({ type: [OrderResponseDto] })
  items!: OrderResponseDto[];

  @ApiProperty({ example: 42, description: 'Total matching orders' })
  total!: number;

  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 20 })
  pageSize!: number;

  @ApiProperty({ example: 3 })
  totalPages!: number;

  static fromPage(page: OrderPageView): PaginatedOrdersResponseDto {
    return {
      items: page.items.map((view) => OrderResponseDto.fromView(view)),
      total: page.total,
      page: page.page,
      pageSize: page.pageSize,
      totalPages: page.totalPages,
    };
  }
}
