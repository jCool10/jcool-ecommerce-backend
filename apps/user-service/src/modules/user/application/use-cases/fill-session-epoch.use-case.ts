import { Inject, Injectable } from '@nestjs/common';
import {
  SESSION_EPOCH,
  SESSION_EPOCH_PUBLISHER,
  type SessionEpochPort,
  type SessionEpochPublisherPort,
} from '../ports';

/**
 * The read-through behind another service's cache miss. It publishes rather than just answering, so
 * that service never has to write the key itself.
 */
@Injectable()
export class FillSessionEpochUseCase {
  constructor(
    @Inject(SESSION_EPOCH) private readonly epochs: SessionEpochPort,
    @Inject(SESSION_EPOCH_PUBLISHER) private readonly publisher: SessionEpochPublisherPort,
  ) {}

  /** Null for an unknown user. */
  async execute(userId: string): Promise<number | null> {
    const epoch = await this.epochs.current(userId);
    return epoch === null ? null : this.publisher.publish(userId, epoch);
  }
}
