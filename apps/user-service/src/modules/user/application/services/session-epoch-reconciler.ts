import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import { durationToMs, toError } from '@jcool/kernel';
import {
  type EpochChangeCursor,
  SESSION_EPOCH_CHANGES,
  SESSION_EPOCH_PUBLISHER,
  type SessionEpochChangesPort,
  type SessionEpochPublisherPort,
} from '../ports';

// Covers a restart: bumps whose publish died with the previous process. A longer access TTL widens
// it, since a missed bump matters for as long as a token minted before it is still accepted.
const MIN_FIRST_PASS_LOOKBACK_MS = 15 * 60_000;
// `updated_at` is stamped by whichever clock wrote it, app or database; this absorbs the skew.
const OVERLAP_MS = 30_000;
const PAGE_SIZE = 500;

const LOG_CONTEXT = 'SessionEpochReconciler';

/**
 * Republishes every epoch the database changed since the last clean pass. Publishing is a max, so
 * going over a user twice is free; missing one leaves a revoked token accepted elsewhere.
 */
@Injectable()
export class SessionEpochReconciler {
  // Start of the last pass that published everything it read.
  private watermark: Date | null = null;
  private readonly firstPassLookbackMs: number;

  constructor(
    @Inject(SESSION_EPOCH_CHANGES) private readonly changes: SessionEpochChangesPort,
    @Inject(SESSION_EPOCH_PUBLISHER) private readonly publisher: SessionEpochPublisherPort,
    private readonly logger: PinoLogger,
    config: ConfigService,
  ) {
    logger.setContext(LOG_CONTEXT);
    this.firstPassLookbackMs = Math.max(
      MIN_FIRST_PASS_LOOKBACK_MS,
      durationToMs(config.getOrThrow<string>('auth.jwtAccessTtl')),
    );
  }

  async reconcileOnce(now = new Date()): Promise<void> {
    const from = this.watermark?.getTime() ?? now.getTime() - this.firstPassLookbackMs;
    const since = new Date(from - OVERLAP_MS);

    let after: EpochChangeCursor | null = null;
    for (;;) {
      const page = await this.changes.listChanges(since, after, PAGE_SIZE);
      for (const change of page) {
        try {
          await this.publisher.publish(change.userId, change.epoch);
        } catch (error) {
          // The watermark stays put, so the next pass starts over from the same point.
          this.logger.warn({ userId: change.userId, err: toError(error) }, 'session epoch reconcile pass aborted');
          return;
        }
      }
      if (page.length < PAGE_SIZE) break;
      after = page[page.length - 1];
    }
    this.watermark = now;
  }
}
