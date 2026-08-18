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
import type { AuthenticatedUser } from '@modules/user/interface/decorators/current-user.decorator';
import {
  IDEMPOTENCY_STORE,
  type IdempotencyRecord,
  type IdempotencyStorePort,
} from '../application/ports/idempotency-store.port';
import type { IdempotentRequest } from './require-idempotency-key.guard';

// How long an IN_PROGRESS row is trusted before it counts as abandoned (owner crashed mid-flight)
// and may be reclaimed. Fixed for now; a config knob can follow once the checkout latency budget
// is measured.
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Wraps a retry-safe endpoint so a repeated Idempotency-Key returns the first result instead of
 * re-executing. The unique (scope, key) index — not an application read-then-write — is the race
 * backstop: `tryInsertInProgress` wins or loses the INSERT atomically. A winner runs the handler
 * and freezes the 2xx result; a loser branches on the stored row (replay COMPLETED / 409 in-flight
 * / 422 body mismatch / reclaim an expired holder). Any thrown result drops the IN_PROGRESS row so
 * the client can safely retry — only deterministic success is cached.
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
      return this.runHandler(scope, key, request.method, next);
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
    return this.runHandler(scope, key, request.method, next);
  }

  private runHandler(scope: string, key: string, method: string, next: CallHandler): Observable<unknown> {
    setIdempotencyContext(this.cls, { scope, key });
    // POST → 201, otherwise 200 — mirrors Nest's default for a handler without @HttpCode, which the
    // wired create endpoint uses. Revisit if an idempotent route overrides its status.
    const successStatus = method === 'POST' ? HttpStatus.CREATED : HttpStatus.OK;

    return next.handle().pipe(
      // Handler failure (business 4xx or unexpected 5xx): nothing deterministic was recorded, so drop
      // the IN_PROGRESS row and let the client retry. This wraps ONLY the handler — a failure of the
      // completion write below instead leaves the row IN_PROGRESS, so a retry gets a safe 409, never a
      // duplicate order. Cleanup failure must not mask the original error.
      catchError((err: unknown) =>
        from(this.store.deleteInProgress(scope, key)).pipe(
          catchError(() => of(undefined)),
          concatMap(() => throwError(() => err)),
        ),
      ),
      // Freeze the successful (2xx) result before the client sees it, so an immediate retry replays a
      // COMPLETED row instead of hitting IN_PROGRESS (409). The authoritative flip moves inside the
      // checkout transaction in the next phase; here it is a standalone write.
      concatMap(async (body: unknown) => {
        await this.store.markCompleted({ scope, key, responseStatus: successStatus, responseBody: body ?? null });
        return body;
      }),
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
