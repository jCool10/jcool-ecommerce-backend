import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { ORDER_STATUSES, OrderStatus } from '../../domain/order-status';

/** Query params for `GET /orders`, in the same shape Catalog's list already uses. */
export class ListOrdersQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 10_000, default: 1, description: 'Page (1-based, max 10000)' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  // OFFSET makes Postgres walk and discard every skipped row, so a deep page is the expensive kind.
  // 10k pages × the 100-item cap is far past any real order history.
  @Max(10_000)
  page = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20, description: 'Items per page (max 100)' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 20;
}

/** The same, plus the operator's two filters. */
export class ListAdminOrdersQueryDto extends ListOrdersQueryDto {
  @ApiPropertyOptional({ enum: ORDER_STATUSES, description: 'Only orders in this status' })
  @IsOptional()
  @IsIn(ORDER_STATUSES)
  status?: OrderStatus;

  @ApiPropertyOptional({ format: 'uuid', description: 'Only orders placed by this user' })
  @IsOptional()
  @IsUUID()
  userId?: string;
}
