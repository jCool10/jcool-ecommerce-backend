import {
  defaultGrpcRetryOptions,
  makeGrpcRetryInterceptor,
  type ConnectionOptions,
  type GrpcRetryOptions,
} from '@temporalio/client';

type GrpcInterceptor = NonNullable<ConnectionOptions['interceptors']>[number];

/**
 * The SDK default retries until the next attempt would start past the deadline, so a call can
 * overrun it by up to one backoff (5s at most). This one gives up as soon as the next backoff would
 * reach the deadline and returns the original error, so a caller with a budget gets its answer in it.
 */
export function deadlineBoundedRetryOptions(
  deadlineMs: number | undefined,
  base: GrpcRetryOptions = defaultGrpcRetryOptions(),
  now: () => number = Date.now,
): GrpcRetryOptions {
  // The SDK asks the decider, then the delay, back to back: the jittered delay is drawn once, here.
  let nextDelayMs = 0;
  return {
    retryableDecider(attempt, status) {
      if (!base.retryableDecider(attempt, status)) return false;
      nextDelayMs = base.delayFunction(attempt, status);
      return deadlineMs === undefined || now() + nextDelayMs < deadlineMs;
    },
    delayFunction: () => nextDelayMs,
  };
}

export function makeDeadlineBoundedRetryInterceptor(base?: GrpcRetryOptions): GrpcInterceptor {
  return (options, nextCall) =>
    makeGrpcRetryInterceptor(deadlineBoundedRetryOptions(deadlineMsOf(options.deadline), base))(options, nextCall);
}

function deadlineMsOf(deadline: Date | number | undefined): number | undefined {
  if (deadline === undefined) return undefined;
  const ms = deadline instanceof Date ? deadline.getTime() : deadline;
  return Number.isFinite(ms) ? ms : undefined;
}
