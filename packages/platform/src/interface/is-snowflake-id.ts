import { BadRequestException, Injectable, type PipeTransform } from '@nestjs/common';
import { ValidateBy, type ValidationOptions, buildMessage } from 'class-validator';
import { isRoutableId } from '@jcool/id-codec';

export const IS_SNOWFLAKE_ID = 'isSnowflakeId';

/** Replaces `@IsUUID()` on every field that carries an id minted by the id service. */
export function IsSnowflakeId(validationOptions?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: IS_SNOWFLAKE_ID,
      validator: {
        validate: (value: unknown) => isRoutableId(value),
        defaultMessage: buildMessage((prefix) => `${prefix}$property must be a routable id`, validationOptions),
      },
    },
    validationOptions,
  );
}

/** Replaces `ParseUUIDPipe` on route params carrying an id minted by the id service. */
@Injectable()
export class ParseSnowflakeIdPipe implements PipeTransform<unknown, string> {
  transform(value: unknown): string {
    if (!isRoutableId(value)) {
      throw new BadRequestException('Validation failed (routable id is expected)');
    }
    return value;
  }
}
