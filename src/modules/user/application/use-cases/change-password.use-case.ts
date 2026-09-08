import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { PASSWORD_HASHER, type PasswordHasherPort, USER_REPOSITORY, type UserRepositoryPort } from '../ports';
import { SessionService } from '../services';

export interface ChangePasswordInput {
  userId: string;
  currentPassword: string;
  newPassword: string;
}

/** Re-verifies the current password: holding a valid access token must not be enough to change it. */
@Injectable()
export class ChangePasswordUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasherPort,
    private readonly sessions: SessionService,
  ) {}

  async execute(input: ChangePasswordInput): Promise<void> {
    const user = await this.users.findById(input.userId);
    // Token was valid but the principal is gone: 401, not 404.
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
