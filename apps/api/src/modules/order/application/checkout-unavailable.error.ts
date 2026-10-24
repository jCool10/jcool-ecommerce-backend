/** The checkout could not get a definite answer in time. The order filter turns it into 503 + Retry-After. */
export class CheckoutUnavailableError extends Error {
  constructor(
    public readonly orderId: string,
    reason: string,
    options?: { cause?: unknown },
  ) {
    super(`Checkout for order ${orderId} unavailable: ${reason}`, options);
    this.name = 'CheckoutUnavailableError';
  }
}
