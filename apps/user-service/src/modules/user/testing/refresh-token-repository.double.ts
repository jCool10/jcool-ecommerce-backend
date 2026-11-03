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
  readonly lookedUp: string[] = [];
  readonly rotations: RotateRefreshTokenInput[] = [];
  readonly revokedFamilies: Array<{ userId: string; familyId: string }> = [];
  readonly revokedAllFor: string[] = [];

  constructor(readonly log: string[] = []) {}

  create(input: CreateRefreshTokenInput): Promise<void> {
    this.log.push('create');
    this.created.push(input);
    return Promise.resolve();
  }

  findOwner(tokenHash: string): Promise<RefreshTokenOwner | null> {
    this.log.push('findOwner');
    this.lookedUp.push(tokenHash);
    return Promise.resolve(this.owner);
  }

  rotate(input: RotateRefreshTokenInput): Promise<RotateOutcome> {
    this.log.push('rotate');
    this.rotations.push(input);
    return Promise.resolve(this.outcome);
  }

  revokeAllForUser(userId: string): Promise<void> {
    this.log.push('revokeAllForUser');
    this.revokedAllFor.push(userId);
    return Promise.resolve();
  }

  listActiveSessions(): Promise<ActiveSession[]> {
    return Promise.resolve([]);
  }

  revokeFamily(userId: string, familyId: string): Promise<boolean> {
    this.log.push('revokeFamily');
    this.revokedFamilies.push({ userId, familyId });
    return Promise.resolve(true);
  }

  deleteCollectable(): Promise<number> {
    return Promise.resolve(0);
  }
}
