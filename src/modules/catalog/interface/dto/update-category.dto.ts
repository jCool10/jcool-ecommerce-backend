import { PartialType } from '@nestjs/swagger';
import { CreateCategoryDto } from './create-category.dto';

/**
 * PATCH body — all CreateCategoryDto fields optional via PartialType. Validators
 * fire only on present fields, so an empty body is a valid no-op.
 */
export class UpdateCategoryDto extends PartialType(CreateCategoryDto) {}
