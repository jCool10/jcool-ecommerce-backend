import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { PASSWORD_HASHER, type PasswordHasherPort } from '../ports/password-hasher.port';
import { USER_REPOSITORY, type UserRepositoryPort } from '../ports/user-repository.port';
import { SessionService } from '../services/session.service';

export interface ChangePasswordInput {
  userId: string;
  currentPassword: string;
  newPassword: string;
}

/**
 * Change an authenticated user's password: re-verify the current password (a valid
 * access token isn't enough), store the new hash, then revoke every session.
 */
@Injectable()
export class ChangePasswordUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasherPort,
    private readonly sessions: SessionService,
  ) {}

  async execute(input: ChangePasswordInput): Promise<void> {
    const user = await this.users.findById(input.userId);
    // Token was valid but the principal is gone — treat as an invalid credential.
    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (!(await this.hasher.verify(user.passwordHash, input.currentPassword))) {
      throw new UnauthorizedException('Current password is incorrect');
    }

    const passwordHash = await this.hasher.hash(input.newPassword);
    await this.users.updatePassword(user.id, passwordHash);
    await this.sessions.revokeAll(user.id);
  }
}
