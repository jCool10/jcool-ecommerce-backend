/** Caller name → the bearer values it may present: the current one and, mid-rotation, the previous. */
export type CallerTokens = Record<string, string[]>;

/** Where `CallerTokenGuard` reads them from; each app fills it in its own configuration. */
export const CALLER_TOKENS_CONFIG_KEY = 'internalApi.callers';

export const callerTokenEnvName = (caller: string): string =>
  `INTERNAL_CALLER_TOKEN_${caller.toUpperCase().replaceAll('-', '_')}`;

export function acceptedTokens(...values: (string | undefined)[]): string[] {
  return values.filter((value): value is string => typeof value === 'string' && value.length > 0);
}

/** Only the callers an app declares are read, so a stray `INTERNAL_CALLER_TOKEN_*` admits no one. */
export function callerTokensFromEnv(
  callers: readonly string[],
  env: Record<string, string | undefined> = process.env,
): CallerTokens {
  return Object.fromEntries(
    callers.map((caller) => {
      const name = callerTokenEnvName(caller);
      return [caller, acceptedTokens(env[name], env[`${name}_PREVIOUS`])];
    }),
  );
}
