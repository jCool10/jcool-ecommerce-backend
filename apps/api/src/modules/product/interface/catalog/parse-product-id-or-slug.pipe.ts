import { Injectable, NotFoundException, type PipeTransform } from '@nestjs/common';
import { isRoutableId } from '@jcool/id-codec';
import { SLUG_PATTERN } from './dto/create-category.dto';

const MAX_SLUG_LENGTH = 200;

/**
 * Anything that is neither a routable id nor a slug can never name a product, so it answers 404
 * before reaching the cache key or Postgres (which rejects a NUL byte in text).
 */
@Injectable()
export class ParseProductIdOrSlugPipe implements PipeTransform<unknown, string> {
  transform(value: unknown): string {
    if (isRoutableId(value)) {
      return value;
    }
    if (typeof value === 'string' && value.length <= MAX_SLUG_LENGTH && SLUG_PATTERN.test(value)) {
      return value;
    }
    throw new NotFoundException('Product not found');
  }
}
