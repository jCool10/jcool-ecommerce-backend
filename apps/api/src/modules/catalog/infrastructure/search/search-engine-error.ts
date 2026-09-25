import { errors, type estypes } from '@elastic/elasticsearch';
import { toError } from '@jcool/kernel';

/** A client error minus its request: the original carries the body and the headers. */
export class SearchEngineError extends Error {
  constructor(
    readonly type: string,
    readonly statusCode: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'SearchEngineError';
  }
}

const VERSION_CONFLICT = 'version_conflict_engine_exception';

// Any other 4xx is the engine refusing our request (mapping, query), not the engine failing.
function isFaultStatus(status: number | undefined): boolean {
  return status === undefined || status >= 500 || status === 429;
}

export function isSearchEngineFault(error: unknown): boolean {
  if (error instanceof errors.ResponseError || error instanceof SearchEngineError) {
    return isFaultStatus(error.statusCode);
  }
  return true;
}

// Bulk answers 200 even when items fail, so only the items say whether the documents landed.
export function assertApplied(response: estypes.BulkResponse, sent: number): void {
  if (!response.errors) return;
  const refused = response.items.flatMap(({ index }) =>
    index?.error && index.error.type !== VERSION_CONFLICT ? [{ type: index.error.type, status: index.status }] : [],
  );
  if (refused.length > 0) {
    // One shed item makes the whole batch the engine's fault, whatever else it refused.
    const reported = refused.find((item) => isFaultStatus(item.status)) ?? refused[0];
    throw new SearchEngineError(
      reported.type,
      reported.status,
      `search engine refused ${refused.length} of ${sent} documents: ${reported.type}`,
    );
  }
}

export function withoutRequest(error: unknown): unknown {
  if (error instanceof errors.ResponseError) {
    const body = error.body as { error?: { type?: unknown } } | undefined;
    const type = typeof body?.error?.type === 'string' ? body.error.type : error.name;
    return new SearchEngineError(type, error.statusCode, error.message);
  }
  if (error instanceof errors.ElasticsearchClientError) {
    return new SearchEngineError(error.name, undefined, error.message);
  }
  return error;
}

export function logShapeOf(error: unknown): { type: string; statusCode?: number; message: string } {
  if (error instanceof SearchEngineError) {
    return { type: error.type, statusCode: error.statusCode, message: error.message };
  }
  const { name, message } = toError(error);
  return { type: name, message };
}
