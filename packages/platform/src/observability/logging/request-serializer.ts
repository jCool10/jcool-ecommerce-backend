interface SerializedRequest {
  url?: string;
  query?: unknown;
  [field: string]: unknown;
}

/** Mailed links are `GET …?token=`, so a query string in a log line is a credential in the log store. */
export function requestWithoutQuery({ query: _query, ...request }: SerializedRequest): SerializedRequest {
  return request.url === undefined ? request : { ...request, url: request.url.split('?', 1)[0] };
}
