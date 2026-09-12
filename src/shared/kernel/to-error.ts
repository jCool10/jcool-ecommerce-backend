/**
 * Normalizes an unknown catch binding into the value pino's `err` field expects.
 *
 * Always log a failure as `logger.error({ err: toError(caught), ...ids }, 'static message')`.
 * pino applies `stdSerializers.err` to the `err` key, so the type, message and stack land as
 * separate queryable fields. Interpolating `${error.message}` into the message instead throws the
 * stack away and gives every failure a distinct message string, which is exactly what makes a log
 * aggregator unable to group them.
 *
 * It lives in the kernel, not next to the logger, because it depends on nothing: application-layer
 * use cases log too, and `app-domain-telemetry-free` keeps them out of `shared/observability`.
 */
export function toError(caught: unknown): Error {
  return caught instanceof Error ? caught : new Error(String(caught));
}
