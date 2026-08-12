import { PartialType } from '@nestjs/swagger';
import { CreateSkuDto } from './create-sku.dto';

/** PATCH body — all CreateSkuDto fields optional (see UpdateCategoryDto). */
export class UpdateSkuDto extends PartialType(CreateSkuDto) {}
