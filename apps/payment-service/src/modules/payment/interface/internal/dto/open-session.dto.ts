import { IsISO8601, IsInt, Matches, Min } from 'class-validator';
import type { OpenSessionBody } from '@jcool/internal-contracts';

export class OpenSessionDto implements OpenSessionBody {
  @IsInt()
  @Min(1)
  amountMinor!: number;

  // Either case: the participant upper-cases it before locking it in.
  @Matches(/^[A-Za-z]{3}$/, { message: 'currency must be a three-letter code' })
  currency!: string;

  // No future check: a deadline under the floor is the participant's CLOSED, not a 400.
  @IsISO8601({ strict: true, strictSeparator: true })
  expiresAt!: string;
}
