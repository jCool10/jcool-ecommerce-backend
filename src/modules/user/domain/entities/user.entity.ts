import type { Role } from '@shared/rbac';

/**
 * Pure — no framework/DB imports. `passwordHash` is the stored argon2id digest, never plaintext;
 * id and timestamps are DB-generated.
 */
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

  get isEmailVerified(): boolean {
    return this.emailVerifiedAt !== null;
  }
}
