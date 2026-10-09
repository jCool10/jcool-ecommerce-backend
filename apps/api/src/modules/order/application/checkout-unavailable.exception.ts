import { ServiceUnavailableException } from '@nestjs/common';

/** A 503 the buyer may retry; the controller turns `retryAfterSec` into the `Retry-After` header. */
export class CheckoutUnavailableException extends ServiceUnavailableException {
  constructor(
    message: string,
    readonly retryAfterSec: number,
  ) {
    super(message);
  }
}
