import type { ConnectionOptions, GrpcRetryOptions } from '@temporalio/client';
import {
  deadlineBoundedRetryOptions,
  makeDeadlineBoundedRetryInterceptor,
} from './deadline-bounded-grpc-retry.interceptor';

type Interceptor = NonNullable<ConnectionOptions['interceptors']>[number];
type NextCall = Parameters<Interceptor>[1];

const OK = 0;
const INVALID_ARGUMENT = 3;
const UNAVAILABLE = 14;
const NOW = 1_000_000;

const status = (code: number) => ({ code, details: `status ${code}`, metadata: {} }) as never;

// Fixed backoff, so each case reads as plain arithmetic.
const base = (delayMs: number): GrpcRetryOptions => ({
  retryableDecider: (attempt, { code }) => attempt < 10 && Number(code) === UNAVAILABLE,
  delayFunction: () => delayMs,
});

describe('deadlineBoundedRetryOptions', () => {
  it('retries a retryable code while the next backoff still ends before the deadline', () => {
    const options = deadlineBoundedRetryOptions(NOW + 500, base(400), () => NOW);

    expect(options.retryableDecider(1, status(UNAVAILABLE))).toBe(true);
    expect(options.delayFunction(1, status(UNAVAILABLE))).toBe(400);
  });

  it('gives up at once when the next backoff would reach the deadline', () => {
    const options = deadlineBoundedRetryOptions(NOW + 500, base(500), () => NOW);

    expect(options.retryableDecider(1, status(UNAVAILABLE))).toBe(false);
  });

  it('never retries a code the base policy refuses', () => {
    const options = deadlineBoundedRetryOptions(NOW + 60_000, base(10), () => NOW);

    expect(options.retryableDecider(1, status(INVALID_ARGUMENT))).toBe(false);
  });

  it('keeps the base attempt cap', () => {
    const options = deadlineBoundedRetryOptions(NOW + 60_000, base(10), () => NOW);

    expect(options.retryableDecider(10, status(UNAVAILABLE))).toBe(false);
  });

  it('falls back to the base policy for a call without a deadline', () => {
    const options = deadlineBoundedRetryOptions(undefined, base(10_000), () => NOW);

    expect(options.retryableDecider(1, status(UNAVAILABLE))).toBe(true);
  });

  it('waits exactly the backoff it judged against the deadline, jitter included', () => {
    let draw = 0;
    const jittery: GrpcRetryOptions = { ...base(0), delayFunction: () => [450, 550][draw++] };
    const options = deadlineBoundedRetryOptions(NOW + 500, jittery, () => NOW);

    expect(options.retryableDecider(1, status(UNAVAILABLE))).toBe(true);
    expect(options.delayFunction(1, status(UNAVAILABLE))).toBe(450);
  });
});

describe('makeDeadlineBoundedRetryInterceptor', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // A next-call stand-in answering each attempt with the next code from `codes`. A message comes
  // first, as on the wire: the SDK interceptor forwards the saved one along with the final status.
  const fakeServer = (codes: number[]) => {
    let attempts = 0;
    const nextCall = (() => ({
      start: (
        _metadata: unknown,
        listener: { onReceiveMessage?: (message: unknown) => void; onReceiveStatus?: (status: unknown) => void },
      ) => {
        const code = codes[Math.min(attempts, codes.length - 1)];
        attempts += 1;
        queueMicrotask(() => {
          listener.onReceiveMessage?.(undefined);
          listener.onReceiveStatus?.(status(code));
        });
      },
      sendMessage: () => undefined,
      sendMessageWithContext: () => undefined,
      halfClose: () => undefined,
      startRead: () => undefined,
      cancelWithStatus: () => undefined,
      getPeer: () => 'fake',
      getAuthContext: () => null,
    })) as unknown as NextCall;
    return { nextCall, attempts: () => attempts };
  };

  const call = (
    interceptor: Interceptor,
    nextCall: NextCall,
    deadline: number,
  ): Promise<{ code: number; at: number }> =>
    new Promise((resolve) => {
      const intercepted = interceptor({ deadline, method_definition: {} } as never, nextCall);
      intercepted.start({} as never, {
        onReceiveMetadata: () => undefined,
        onReceiveMessage: () => undefined,
        onReceiveStatus: ({ code }: { code: number }) => resolve({ code, at: Date.now() }),
      });
      intercepted.sendMessage({});
      intercepted.halfClose();
    });

  it('retries through an outage that ends before the deadline and leaves no timer behind', async () => {
    const server = fakeServer([UNAVAILABLE, UNAVAILABLE, OK]);
    const interceptor = makeDeadlineBoundedRetryInterceptor(base(100));

    const answer = call(interceptor, server.nextCall, NOW + 1_000);
    await vi.advanceTimersByTimeAsync(250);

    await expect(answer).resolves.toMatchObject({ code: OK });
    expect(server.attempts()).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('hands back the original error before the deadline once a backoff would overrun it', async () => {
    const server = fakeServer([UNAVAILABLE]);
    const interceptor = makeDeadlineBoundedRetryInterceptor(base(400));

    const answer = call(interceptor, server.nextCall, NOW + 1_000);
    await vi.advanceTimersByTimeAsync(2_000);

    // Attempts at 0, 400 and 800; a fourth would start at 1200, past the deadline.
    await expect(answer).resolves.toEqual({ code: UNAVAILABLE, at: NOW + 800 });
    expect(server.attempts()).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
  });
});
