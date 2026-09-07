import pino from 'pino';

/**
 * The two pino options that decide what a log line looks like on the wire, kept in one place
 * because two writers have to agree on them: the app logger ({@link buildLoggerParams}) and the
 * bootstrap-failure logger, which runs when the app logger does not exist yet. A boot failure
 * printed in a different shape is the one line nobody can query.
 */

/** ISO-8601 instead of pino's epoch ms — every log platform parses it without a per-source rule. */
export const ISO_TIMESTAMP = pino.stdTimeFunctions.isoTime;

/** pino emits `level` as a number by default; every log platform filters on the word. */
export function levelAsWord(label: string): Record<string, string> {
  return { level: label };
}
