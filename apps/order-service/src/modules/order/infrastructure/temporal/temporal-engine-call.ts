import {
  ServiceError,
  WorkflowExecutionAlreadyStartedError,
  WorkflowNotFoundError,
  WorkflowUpdateRPCTimeoutOrCancelledError,
  type Client,
} from '@temporalio/client';
import {
  CheckoutEngineUnavailableError,
  CheckoutSagaClosedError,
} from '../../application/ports/checkout-saga-engine.port';

// The server enforces the same grpc-timeout, and when its timer fires first it resets the stream,
// which grpc-js reports as CANCELLED. Nothing here cancels a call itself, so both mean out of time.
const OUT_OF_TIME_GRPC_CODES = new Set<unknown>([
  1, // CANCELLED
  4, // DEADLINE_EXCEEDED
]);

// What a ServiceError's cause carries when Temporal cannot answer now. FAILED_PRECONDITION from
// Update-with-Start means the workflow task keeps failing: retry or investigate, never a refusal.
const UNAVAILABLE_GRPC_CODES = new Set<unknown>([
  ...OUT_OF_TIME_GRPC_CODES,
  8, // RESOURCE_EXHAUSTED
  9, // FAILED_PRECONDITION
  14, // UNAVAILABLE
]);

/** The error a call gets from a closed run; the same class elsewhere means something else. */
export type ClosedRunError = typeof WorkflowNotFoundError | typeof WorkflowExecutionAlreadyStartedError;

const grpcCodeOf = (error: ServiceError): unknown => (error.cause as { code?: unknown } | undefined)?.code;

/** The call ran out of its own deadline, which past a confirmed start means the run is still going. */
export function isDeadlineExceeded(error: unknown): boolean {
  return error instanceof ServiceError && OUT_OF_TIME_GRPC_CODES.has(grpcCodeOf(error));
}

// By class first: the SDK wraps gRPC errors in ServiceError and throws an update past its deadline
// as WorkflowUpdateRPCTimeoutOrCancelledError, with no code on the error itself.
export function toEngineError(error: unknown, orderId: string, closedBy: ClosedRunError | null): unknown {
  if (error instanceof WorkflowUpdateRPCTimeoutOrCancelledError) {
    return new CheckoutEngineUnavailableError({ cause: error });
  }
  if (error instanceof ServiceError) {
    return UNAVAILABLE_GRPC_CODES.has(grpcCodeOf(error)) ? new CheckoutEngineUnavailableError({ cause: error }) : error;
  }
  if (closedBy && error instanceof closedBy) return new CheckoutSagaClosedError(orderId);
  return error;
}

/** Every client call inside `send` shares one absolute deadline, long-polls and their re-polls included. */
export async function withinDeadline<T>(
  client: Client,
  waitMs: number,
  send: () => Promise<T>,
  mapError: (error: unknown) => unknown,
): Promise<T> {
  try {
    return await client.connection.withDeadline(Date.now() + waitMs, send);
  } catch (error) {
    throw mapError(error);
  }
}
