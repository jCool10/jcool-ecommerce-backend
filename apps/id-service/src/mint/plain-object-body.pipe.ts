import { BadRequestException, Injectable, type PipeTransform } from '@nestjs/common';

/** The global ValidationPipe validates an array body element by element and hands it on, so `[]` would pass untouched. */
@Injectable()
export class PlainObjectBodyPipe implements PipeTransform {
  transform(value: unknown): unknown {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new BadRequestException('request body must be a JSON object');
    }
    return value;
  }
}
