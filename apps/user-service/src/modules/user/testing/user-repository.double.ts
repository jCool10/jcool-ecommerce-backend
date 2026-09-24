import { User } from '../domain/entities/user.entity';
import type { CreateUserInput, UserRepositoryPort } from '../application/ports';

/** Holds at most one user and records what each call was asked; `log` orders calls across fakes. */
export class FakeUserRepository implements UserRepositoryPort {
  user: User | null = null;
  /** `create` answers null, as the unique email index does for a taken address. */
  emailTaken = false;
  lastFindEmail?: string;
  created?: CreateUserInput;
  readonly verified: string[] = [];
  readonly passwordUpdates: Array<{ userId: string; passwordHash: string }> = [];

  constructor(readonly log: string[] = []) {}

  findByEmail(email: string): Promise<User | null> {
    this.lastFindEmail = email;
    return Promise.resolve(this.user);
  }

  findById(id: string): Promise<User | null> {
    return Promise.resolve(this.user?.id === id ? this.user : null);
  }

  create(input: CreateUserInput): Promise<User | null> {
    if (this.emailTaken) return Promise.resolve(null);
    this.created = input;
    this.user = new User('new-id', input.email, input.passwordHash, input.role ?? 'CUSTOMER', new Date(), new Date());
    return Promise.resolve(this.user);
  }

  markEmailVerified(userId: string): Promise<void> {
    this.verified.push(userId);
    return Promise.resolve();
  }

  updatePassword(userId: string, passwordHash: string): Promise<void> {
    this.log.push('updatePassword');
    this.passwordUpdates.push({ userId, passwordHash });
    return Promise.resolve();
  }
}
