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
    @Inject(USER_REPOSITORY) private readonly userRepo: UserRepositoryPort,
    @Inject(PASSWORD_HASHER) private readonly passwordHasher: PasswordHasherPort,
    private readonly sessionService: SessionService,
  ) {}

  async execute(input: ChangePasswordInput): Promise<void> {
    const user = await this.userRepo.findById(input.userId);
    // Token was valid but the principal is gone: 401, not 404.
    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (!(await this.passwordHasher.verify(user.passwordHash, input.currentPassword))) {
      throw new UnauthorizedException('Current password is incorrect');
    }

    const passwordHash = await this.passwordHasher.hash(input.newPassword);
    // Refused when a reset replaced the hash verified above, so a stale change cannot undo it.
    const replaced = await this.sessionService.replacePassword(user.id, {
      newPasswordHash: passwordHash,
      verifiedPasswordHash: user.passwordHash,
    });
    if (!replaced) {
      throw new UnauthorizedException('Current password is incorrect');
    }
  }
}
