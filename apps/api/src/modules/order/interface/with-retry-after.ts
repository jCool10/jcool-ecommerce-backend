import type { Response } from 'express';
import { CheckoutUnavailableException } from '../application/checkout-unavailable.exception';

export async function withRetryAfter<T>(res: Response, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    // Set before rethrowing: the exception filter writes the body onto this same response.
    if (error instanceof CheckoutUnavailableException) res.setHeader('Retry-After', String(error.retryAfterSec));
    throw error;
  }
}
