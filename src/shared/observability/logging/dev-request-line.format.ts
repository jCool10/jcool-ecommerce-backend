// morgan 'dev'-style request line for the local pretty console, e.g.
//   GET /products/:idOrSlug 200 12.345 ms - 431
// Status is colored by class; the trailing dimmed `db=N` is our per-request query tally.
// Dev-only — production emits structured JSON. See ADR-0013.

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';

// morgan's status palette (SGR foreground codes); 1xx / unknown stays uncolored like morgan.
function statusColor(statusCode: number): string {
  if (statusCode >= 500) return '\x1b[31m'; // red
  if (statusCode >= 400) return '\x1b[33m'; // yellow
  if (statusCode >= 300) return '\x1b[36m'; // cyan
  if (statusCode >= 200) return '\x1b[32m'; // green
  return RESET;
}

export interface DevRequestLineParts {
  method: string;
  route: string;
  statusCode: number;
  /** Elapsed ms (3-decimal), or undefined before the request-start stamp exists. */
  durationMs: number | undefined;
  /** Response `content-length` header, when one was set. */
  contentLength?: number | string | string[];
  /** Per-request DB query tally (an N+1 signal). */
  dbQueries?: number;
}

/** Build the morgan `dev`-shaped one-liner. Missing time/size render as `-`, matching morgan. */
export function formatDevRequestLine(parts: DevRequestLineParts): string {
  const { method, route, statusCode, durationMs, contentLength, dbQueries } = parts;
  const status = `${statusColor(statusCode)}${statusCode}${RESET}`;
  const time = durationMs === undefined ? '-' : `${durationMs} ms`;
  const size = contentLength === undefined || contentLength === '' ? '-' : String(contentLength);
  const db = dbQueries === undefined ? '' : ` ${DIM}db=${dbQueries}${RESET}`;
  return `${method} ${route} ${status} ${time} - ${size}${db}`;
}
