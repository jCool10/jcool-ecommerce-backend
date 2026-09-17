import {
  CallHandler,
  ConflictException,
  ExecutionContext,
  HttpStatus,
  Inject,
  Injectable,
  NestInterceptor,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Response } from 'express';
import { ClsService } from 'nestjs-cls';
import { type Observable, catchError, concatMap, from, of, throwError } from 'rxjs';
import { computeRequestHash, setIdempotencyContext } from '@shared/idempotency';
import type { AuthenticatedUser } from '@shared/rbac';
import {
  IDEMPOTENCY_STORE,
  type IdempotencyRecord,
  type IdempotencyStorePort,
} from '../application/ports/idempotency-store.port';
import type { IdempotentRequest } from './require-idempotency-key.guard';

// How long an IN_PROGRESS row is trusted before it counts as abandoned (owner crashed mid-flight)
// and may be reclaimed.
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The unique (scope, key) index — not an application read-then-write — is the race backstop:
 * `tryInsertInProgress` wins or loses the INSERT atomically. Only a committed success is cached;
 * any thrown result drops the IN_PROGRESS row so the client can safely retry.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    @Inject(IDEMPOTENCY_STORE) private readonly store: IdempotencyStorePort,
    private readonly cls: ClsService,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const http = context.switchToHttp();
    const request = http.getRequest<IdempotentRequest & { user?: AuthenticatedUser }>();
    const response = http.getResponse<Response>();

    const user = request.user;
    const key = request.idempotencyKey;
    // The guard guarantees both on the wired route; bail out defensively rather than throw if this
    // interceptor is ever mounted without it.
    if (!user || !key) {
      return next.handle();
    }

    const scope = `user:${user.userId}`;
    const requestHash = computeRequestHash(request.method, request.path, scope, request.body);
    const insertInput = {
      scope,
      key,
      requestHash,
      method: request.method,
      path: request.path,
      expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
    };

    const inserted = await this.store.tryInsertInProgress(insertInput);
    if (inserted) {
      return this.runHandler(scope, key, next);
    }

    const existing = await this.store.findByScopeAndKey(scope, key);
    if (!existing) {
      // Row vanished between the failed insert and this read (a sibling cleaned up its own failed
      // attempt). Transient — have the client retry.
      throw new ConflictException('Idempotent request is being processed; please retry');
    }

    if (existing.requestHash !== requestHash) {
      throw new UnprocessableEntityException('Idempotency-Key was reused with a different request');
    }

    if (existing.status === 'COMPLETED') {
      return this.replay(existing, response);
    }

    // IN_PROGRESS: still within TTL → a genuine concurrent request; past TTL → owner crashed, reclaim.
    if (existing.expiresAt.getTime() > Date.now()) {
      throw new ConflictException('A request with this Idempotency-Key is already in progress');
    }

    // Expiry-scoped delete: if a racing reclaimer already refreshed this row, it is no longer expired
    // and survives, so our re-INSERT below loses on the unique index (→ 409) instead of both running.
    await this.store.deleteExpiredInProgress(scope, key, new Date());
    const reclaimed = await this.store.tryInsertInProgress(insertInput);
    if (!reclaimed) {
      // Another request reclaimed first — treat as in-progress.
      throw new ConflictException('A request with this Idempotency-Key is already in progress');
    }
    return this.runHandler(scope, key, next);
  }

  private runHandler(scope: string, key: string, next: CallHandler): Observable<unknown> {
    // Handed over CLS because the checkout transaction flips this row to COMPLETED inside the same
    // unit of work as the order + reservation; on success this interceptor does nothing more.
    setIdempotencyContext(this.cls, { scope, key });

    return next.handle().pipe(
      // Handler failure (business 4xx or unexpected 5xx): the checkout tx rolled back, so nothing
      // committed and the row was never marked COMPLETED. Drop the IN_PROGRESS row so the client can
      // retry. Cleanup failure must not mask the original error.
      catchError((err: unknown) =>
        from(this.store.deleteInProgress(scope, key)).pipe(
          catchError(() => of(undefined)),
          concatMap(() => throwError(() => err)),
        ),
      ),
    );
  }

  private replay(record: IdempotencyRecord, response: Response): Observable<unknown> {
    // Nest's response controller re-applies the route's reflected status (201 for this POST route) to
    // the emitted value afterward, so this set only bites if that default ever diverges from the
    // cached status. Caching only 2xx on a 201 route keeps them equal — replay returns the original.
    response.status(record.responseStatus ?? HttpStatus.OK);
    return of(record.responseBody);
  }
}
