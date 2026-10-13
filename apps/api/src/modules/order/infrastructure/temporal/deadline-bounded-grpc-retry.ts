import {
  type ConnectionOptions,
  defaultGrpcRetryOptions,
  type GrpcRetryOptions,
  makeGrpcRetryInterceptor,
} from '@temporalio/client';

type GrpcInterceptor = NonNullable<ConnectionOptions['interceptors']>[number];

/**
 * The SDK's default retry, except it stops once the next backoff would end past the call's deadline.
 * The stock interceptor sleeps that backoff out regardless, so a caller of an unreachable server
 * hears back seconds after its own deadline.
 */
export function deadlineBoundedRetryOptions(deadlineMs: number, now: () => number = Date.now): GrpcRetryOptions {
  const defaults = defaultGrpcRetryOptions();
  let delayMs = 0;
  return {
    retryableDecider(attempt, status) {
      if (!defaults.retryableDecider(attempt, status)) return false;
      // Jittered, so drawn once here; the interceptor asks for the delay right after this.
      delayMs = defaults.delayFunction(attempt, status);
      return now() + delayMs < deadlineMs;
    },
    delayFunction: () => delayMs,
  };
}

export function deadlineBoundedRetryInterceptor(): GrpcInterceptor {
  return (options, nextCall) => {
    const deadlineMs = options.deadline === undefined ? Infinity : Number(options.deadline);
    return makeGrpcRetryInterceptor(deadlineBoundedRetryOptions(deadlineMs))(options, nextCall);
  };
}
