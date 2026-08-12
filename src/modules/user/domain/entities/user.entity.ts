import type { Role } from '../../../../shared/rbac/role.enum';

/**
 * User domain entity — pure, no framework/DB imports. `passwordHash` is the
 * stored argon2id digest (never plaintext); the entity holds it but has no
 * opinion on hashing. Identity + timestamps are DB-generated.
 */
export class User {
  constructor(
    public readonly id: string,
    public readonly email: string,
    public readonly passwordHash: string,
    public readonly role: Role,
    public readonly createdAt: Date,
    public readonly updatedAt: Date,
  ) {}

  /** Reconstitute a User from stored attributes (e.g. a persisted row). Pure, no I/O. */
  static create(props: {
    id: string;
    email: string;
    passwordHash: string;
    role: Role;
    createdAt: Date;
    updatedAt: Date;
  }): User {
    return new User(props.id, props.email, props.passwordHash, props.role, props.createdAt, props.updatedAt);
  }
}
