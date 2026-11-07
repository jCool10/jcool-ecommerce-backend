// No Nest import: the trace preloads load this before Nest is patched.

/** V8's JSON.parse message quotes the request body around the fault, so it never leaves as is. */
export const JSON_PARSE_ERROR = /(in JSON at position \d+|is not valid JSON|Unexpected end of JSON input)/;

export const MALFORMED_BODY_REASON = 'malformed request body';
