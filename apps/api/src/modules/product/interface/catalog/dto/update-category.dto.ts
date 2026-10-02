import { PartialType } from '@nestjs/swagger';
import { CreateCategoryDto } from './create-category.dto';

/** Validators fire only on present fields, so an empty body is a valid no-op. */
export class UpdateCategoryDto extends PartialType(CreateCategoryDto) {}
