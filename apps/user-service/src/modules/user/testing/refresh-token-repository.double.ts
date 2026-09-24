import type {
  ActiveSession,
  CreateRefreshTokenInput,
  RefreshTokenOwner,
  RefreshTokenRepositoryPort,
  RotateOutcome,
  RotateRefreshTokenInput,
} from '../application/ports';

/** Answers `owner` and `outcome` as the spec sets them and records every write; `log` orders calls across fakes. */
export class FakeRefreshTokenRepository implements RefreshTokenRepositoryPort {
  owner: RefreshTokenOwner | null = null;
  outcome: RotateOutcome = { status: 'invalid' };
  readonly created: CreateRefreshTokenInput[] = [];
  readonly rotations: RotateRefreshTokenInput[] = [];
  readonly revoked: Array<{ userId: string; tokenHash: string }> = [];
  readonly revokedAllFor: string[] = [];

  constructor(readonly log: string[] = []) {}

  create(input: CreateRefreshTokenInput): Promise<void> {
    this.log.push('create');
    this.created.push(input);
    return Promise.resolve();
  }

  findOwner(): Promise<RefreshTokenOwner | null> {
    this.log.push('findOwner');
    return Promise.resolve(this.owner);
  }

  rotate(input: RotateRefreshTokenInput): Promise<RotateOutcome> {
    this.log.push('rotate');
    this.rotations.push(input);
    return Promise.resolve(this.outcome);
  }

  revoke(userId: string, tokenHash: string): Promise<void> {
    this.log.push('revoke');
    this.revoked.push({ userId, tokenHash });
    return Promise.resolve();
  }

  revokeAllForUser(userId: string): Promise<void> {
    this.log.push('revokeAllForUser');
    this.revokedAllFor.push(userId);
    return Promise.resolve();
  }

  listActiveSessions(): Promise<ActiveSession[]> {
    return Promise.resolve([]);
  }

  revokeFamily(): Promise<boolean> {
    return Promise.resolve(false);
  }

  deleteCollectable(): Promise<number> {
    return Promise.resolve(0);
  }
}
