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
    // Not atomic, so ordered to fail safe: a crash between them leaves the old password with every
    // session gone, never the reverse. Still open — the old password verifies until the second write,
    // and a login racing it INSERTs a refresh family after revokeAllForUser has already passed, so no
    // later write to the users row revokes it. Closing that needs both writes in one transaction.
    await this.sessions.revokeAll(user.id);
    await this.users.updatePassword(user.id, passwordHash);
  }
}
