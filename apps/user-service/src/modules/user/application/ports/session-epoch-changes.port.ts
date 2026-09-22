export const SESSION_EPOCH_CHANGES = Symbol('SESSION_EPOCH_CHANGES');

/** `updatedAt` is Postgres text, exact to the microsecond; only ever handed back as a cursor. */
export interface EpochChange {
  userId: string;
  epoch: number;
  updatedAt: string;
}

export type EpochChangeCursor = Pick<EpochChange, 'userId' | 'updatedAt'>;

export interface SessionEpochChangesPort {
  /** Users in `(updatedAt, userId)` order: from `since`, or strictly past `after` once paging. */
  listChanges(since: Date, after: EpochChangeCursor | null, limit: number): Promise<EpochChange[]>;
}
