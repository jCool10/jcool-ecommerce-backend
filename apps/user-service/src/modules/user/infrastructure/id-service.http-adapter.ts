import { ServiceUnavailableException } from '@nestjs/common';
import { bucketOf } from '@jcool/id-codec';
import type { OutboundCall } from '@jcool/platform/resilience';
import type { IdGeneratorPort } from '../application/ports';

export const ID_SERVICE_BREAKER = 'id-service';

const LEASE_NOT_HELD = 'LEASE_NOT_HELD';

/** The id service answered, and the answer was not ids. */
export class IdServiceRejection extends Error {
  constructor(
    readonly status: number,
    readonly code?: string,
  ) {
    super(`id service answered ${status}${code ? ` ${code}` : ''}`);
    this.name = 'IdServiceRejection';
  }
}

/**
 * LEASE_NOT_HELD is a replica between leases, which the gateway already retried around; a 4xx is our
 * request. Neither says the service is down, so neither counts toward opening the circuit.
 */
export function isIdServiceFault(error: unknown): boolean {
  if (!(error instanceof IdServiceRejection)) return true;
  return error.code !== LEASE_NOT_HELD && !(error.status >= 400 && error.status < 500);
}

// A row keyed by an id from another bucket would live on a shard that does not own it.
function isIdInBucket(id: unknown, bucket: number): boolean {
  if (typeof id !== 'string') return false;
  try {
    return bucketOf(id) === bucket;
  } catch {
    return false;
  }
}

function isIdList(value: unknown, count: number, bucket: number): value is string[] {
  return Array.isArray(value) && value.length === count && value.every((id) => isIdInBucket(id, bucket));
}

export interface IdServiceOptions {
  url: string;
  timeoutMs: number;
}

/** No retry here: the gateway in front of the replicas holds the only retry budget. */
export class IdServiceHttpAdapter implements IdGeneratorPort {
  constructor(
    private readonly options: IdServiceOptions,
    private readonly breaker: OutboundCall,
  ) {}

  async mint(bucket: number, count = 1): Promise<string[]> {
    try {
      return await this.breaker.run(() => this.request(bucket, count));
    } catch (error) {
      // No local fallback exists, so every way of not getting ids is the same answer to the client.
      throw new ServiceUnavailableException('Service unavailable', { cause: error });
    }
  }

  private async request(bucket: number, count: number): Promise<string[]> {
    const response = await fetch(new URL('/v1/ids', this.options.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-caller': 'user-service' },
      body: JSON.stringify({ bucket, count }),
      // The breaker stops waiting at the same point; this also frees the socket.
      signal: AbortSignal.timeout(this.options.timeoutMs),
    });
    const body = (await response.json().catch(() => null)) as { ids?: unknown; code?: unknown } | null;

    if (!response.ok) {
      throw new IdServiceRejection(response.status, typeof body?.code === 'string' ? body.code : undefined);
    }
    const ids = body?.ids;
    if (!isIdList(ids, count, bucket)) {
      throw new IdServiceRejection(response.status, 'MALFORMED_RESPONSE');
    }
    return ids;
  }
}
