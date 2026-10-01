import { ServiceUnavailableException } from '@nestjs/common';
import type { ClsService } from 'nestjs-cls';
import { SEQUENCE_COUNT, isRoutableId } from '@jcool/id-codec';
import { correlationHeaders } from '../observability';
import type { OutboundCall } from '../resilience';

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

function isIdList(value: unknown, count: number): value is string[] {
  return Array.isArray(value) && value.length === count && value.every(isRoutableId);
}

export interface IdServiceOptions {
  url: string;
  timeoutMs: number;
  /** Sent as `x-caller`, which labels the id service's mint counter. */
  caller: string;
}

// The id service's per-request cap: one node-millisecond.
const MAX_IDS_PER_REQUEST = SEQUENCE_COUNT;

/** No retry here: the gateway in front of the replicas holds the only retry budget. */
export class IdServiceHttpAdapter {
  constructor(
    private readonly options: IdServiceOptions,
    private readonly breaker: OutboundCall,
    private readonly cls: ClsService,
  ) {}

  async mint(count = 1): Promise<string[]> {
    const ids: string[] = [];
    for (let left = count; left > 0; left -= MAX_IDS_PER_REQUEST) {
      ids.push(...(await this.mintBatch(Math.min(left, MAX_IDS_PER_REQUEST))));
    }
    return ids;
  }

  private async mintBatch(count: number): Promise<string[]> {
    try {
      return await this.breaker.run(() => this.request(count));
    } catch (error) {
      // No local fallback exists, so every way of not getting ids is the same answer to the client.
      throw new ServiceUnavailableException('Service unavailable', { cause: error });
    }
  }

  private async request(count: number): Promise<string[]> {
    const response = await fetch(new URL('/v1/ids', this.options.url), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-caller': this.options.caller,
        ...correlationHeaders(this.cls),
      },
      body: JSON.stringify({ count }),
      // The breaker stops waiting at the same point; this also frees the socket.
      signal: AbortSignal.timeout(this.options.timeoutMs),
    });
    const body = (await response.json().catch(() => null)) as { ids?: unknown; code?: unknown } | null;

    if (!response.ok) {
      throw new IdServiceRejection(response.status, typeof body?.code === 'string' ? body.code : undefined);
    }
    const ids = body?.ids;
    if (!isIdList(ids, count)) {
      throw new IdServiceRejection(response.status, 'MALFORMED_RESPONSE');
    }
    return ids;
  }
}
