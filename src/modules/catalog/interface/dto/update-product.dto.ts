import { PartialType } from '@nestjs/swagger';
import { CreateProductDto } from './create-product.dto';

/** PATCH body — all CreateProductDto fields optional (see UpdateCategoryDto). */
export class UpdateProductDto extends PartialType(CreateProductDto) {}
