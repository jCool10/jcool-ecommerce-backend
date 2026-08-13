import type { Role } from '../../../../shared/rbac/role.enum';

/** User domain entity — pure, no framework/DB imports; `passwordHash` is the stored argon2id digest (never plaintext), identity + timestamps are DB-generated. */
export class User {
  constructor(
    public readonly id: string,
    public readonly email: string,
    public readonly passwordHash: string,
    public readonly role: Role,
    public readonly createdAt: Date,
    public readonly updatedAt: Date,
    public readonly emailVerifiedAt: Date | null = null,
    public readonly tokenEpoch: number = 0,
  ) {}

  /** Reconstitute a User from stored attributes (e.g. a persisted row). Pure, no I/O. */
  static create(props: {
    id: string;
    email: string;
    passwordHash: string;
    role: Role;
    createdAt: Date;
    updatedAt: Date;
    emailVerifiedAt?: Date | null;
    tokenEpoch?: number;
  }): User {
    return new User(
      props.id,
      props.email,
      props.passwordHash,
      props.role,
      props.createdAt,
      props.updatedAt,
      props.emailVerifiedAt ?? null,
      props.tokenEpoch ?? 0,
    );
  }

  /** True once the email address has been verified. */
  get isEmailVerified(): boolean {
    return this.emailVerifiedAt !== null;
  }
}
