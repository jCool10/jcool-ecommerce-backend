import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsISO8601,
  IsInt,
  Min,
  ValidateBy,
  ValidateNested,
  type ValidationOptions,
} from 'class-validator';
import type { ReservationLineBody, TryReservationBody } from '@jcool/internal-contracts';
import { IsSnowflakeId } from '@jcool/platform/interface';

function IsInTheFuture(options?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'isInTheFuture',
      validator: {
        validate: (value: unknown) => typeof value === 'string' && Date.parse(value) > Date.now(),
        defaultMessage: () => '$property must be in the future',
      },
    },
    options,
  );
}

export class ReservationLineDto implements ReservationLineBody {
  @IsSnowflakeId()
  variantId!: string;

  @IsInt()
  @Min(1)
  quantity!: number;
}

export class TryReservationDto implements TryReservationBody {
  @IsArray()
  @ArrayNotEmpty()
  // The participant holds a variant once per order, so a second line for it would be dropped silently.
  @ArrayUnique((line: ReservationLineDto | null) => line?.variantId, { message: 'lines must name each variant once' })
  @ValidateNested({ each: true })
  @Type(() => ReservationLineDto)
  lines!: ReservationLineDto[];

  @IsISO8601({ strict: true, strictSeparator: true })
  @IsInTheFuture()
  holdUntil!: string;
}
