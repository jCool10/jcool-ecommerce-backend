import type { Mock } from 'vitest';

/** What pino would print for these logger calls: an Error's message, stack and cause, not JSON's `{}`. */
export const loggedText = (...logs: Mock[]): string =>
  JSON.stringify(
    logs.flatMap((log) => log.mock.calls),
    (_key, value: unknown) =>
      value instanceof Error ? { message: value.message, stack: value.stack, cause: value.cause } : value,
  );
