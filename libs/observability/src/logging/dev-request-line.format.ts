// morgan 'dev'-style request line for the local pretty console; production emits structured JSON.

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';

// morgan's status palette (SGR foreground codes); 1xx / unknown stays uncolored, as morgan does.
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
  durationMs: number | undefined;
  contentLength?: number | string | string[];
  dbQueries?: number;
}

// Missing time/size render as `-`, matching morgan.
export function formatDevRequestLine(parts: DevRequestLineParts): string {
  const { method, route, statusCode, durationMs, contentLength, dbQueries } = parts;
  const status = `${statusColor(statusCode)}${statusCode}${RESET}`;
  const time = durationMs === undefined ? '-' : `${durationMs} ms`;
  const size = contentLength === undefined || contentLength === '' ? '-' : String(contentLength);
  const db = dbQueries === undefined ? '' : ` ${DIM}db=${dbQueries}${RESET}`;
  return `${method} ${route} ${status} ${time} - ${size}${db}`;
}
