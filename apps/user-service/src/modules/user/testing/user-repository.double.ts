import type { User } from '../domain/entities/user.entity';
import type { UserRepositoryPort } from '../application/ports';

/**
 * The one user-repository double that was written twice, byte for byte: a lookup by email that
 * records the address it was asked for.
 *
 * The other four hand-rolled repositories in this context stay where they are — each records a
 * different call (the password it stored, the id it verified, the input it created), and merging
 * them into one configurable class would hide the thing each spec is actually asserting on.
 */
/**
 * Not `implements Partial<UserRepositoryPort>`: `Partial` makes every member optional, so it accepts
 * a class that implements nothing and would keep compiling through a rename of `findByEmail`. This
 * pins the one method's signature to the port instead, which is the only part callers rely on.
 */
export class EmailLookupUserRepository {
  user: User | null = null;
  lastFindEmail?: string;

  findByEmail(email: string): ReturnType<UserRepositoryPort['findByEmail']> {
    this.lastFindEmail = email;
    return Promise.resolve(this.user);
  }
}
