import type {
  ActiveSession,
  CreateRefreshTokenInput,
  CreateRefreshTokenOutcome,
  PasswordReplacement,
  RefreshTokenOwner,
  RefreshTokenRepositoryPort,
  RotateOutcome,
  RotateRefreshTokenInput,
} from '../application/ports';

/**
 * Answers `owner`, `outcome`, `createOutcome` and `revokeAllEpoch` as the spec sets them and records
 * every write; `log` orders calls across fakes.
 */
export class FakeRefreshTokenRepository implements RefreshTokenRepositoryPort {
  owner: RefreshTokenOwner | null = null;
  outcome: RotateOutcome = { status: 'invalid' };
  createOutcome: CreateRefreshTokenOutcome = { status: 'created', role: 'CUSTOMER', tokenEpoch: 0 };
  revokeAllEpoch: number | null = 1;
  readonly created: CreateRefreshTokenInput[] = [];
  readonly lookedUp: string[] = [];
  readonly rotations: RotateRefreshTokenInput[] = [];
  readonly revokedFamilies: Array<{ userId: string; familyId: string }> = [];
  readonly revokedAll: Array<{ userId: string } & Partial<PasswordReplacement>> = [];

  constructor(readonly log: string[] = []) {}

  create(input: CreateRefreshTokenInput): Promise<CreateRefreshTokenOutcome> {
    this.log.push('create');
    this.created.push(input);
    return Promise.resolve(this.createOutcome);
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

  revokeAllForUser(userId: string, replacement?: PasswordReplacement): Promise<number | null> {
    this.log.push('revokeAllForUser');
    this.revokedAll.push({ userId, ...replacement });
    return Promise.resolve(this.revokeAllEpoch);
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
