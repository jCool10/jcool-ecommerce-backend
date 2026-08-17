import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '@shared/infrastructure/database';
import { users } from './schema/user.schema';
import { User } from '../domain/entities/user.entity';
import type { CreateUserInput, UserRepositoryPort } from '../application/ports';

type UserRow = typeof users.$inferSelect;

function toDomain(row: UserRow): User {
  return User.create({
    id: row.id,
    email: row.email,
    passwordHash: row.passwordHash,
    role: row.role,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    emailVerifiedAt: row.emailVerifiedAt,
    tokenEpoch: row.tokenEpoch,
  });
}

// Drizzle adapter for UserRepositoryPort. The unique email index is the sole
// uniqueness guarantee: create() inserts ON CONFLICT DO NOTHING so concurrent
// signups serialize on the index — the losing writer gets a null row, not a 23505.
@Injectable()
export class DrizzleUserRepository implements UserRepositoryPort {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  async findByEmail(email: string): Promise<User | null> {
    const rows = await this.db.select().from(users).where(eq(users.email, email)).limit(1);
    return rows[0] ? toDomain(rows[0]) : null;
  }

  async findById(id: string): Promise<User | null> {
    const rows = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    return rows[0] ? toDomain(rows[0]) : null;
  }

  async create(input: CreateUserInput): Promise<User | null> {
    const [row] = await this.db
      .insert(users)
      .values({
        email: input.email,
        passwordHash: input.passwordHash,
        // Omit `role` when unset so the column default (CUSTOMER) applies.
        ...(input.role ? { role: input.role } : {}),
      })
      .onConflictDoNothing({ target: users.email })
      .returning();
    return row ? toDomain(row) : null; // no row ⇒ email already taken
  }

  async markEmailVerified(userId: string): Promise<void> {
    await this.db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, userId));
  }

  async updatePassword(userId: string, passwordHash: string): Promise<void> {
    await this.db.update(users).set({ passwordHash }).where(eq(users.id, userId));
  }
}
