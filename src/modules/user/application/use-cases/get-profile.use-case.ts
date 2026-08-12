import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { User } from '../../domain/entities/user.entity';
import { USER_REPOSITORY, type UserRepositoryPort } from '../ports/user-repository.port';

/**
 * Load the full profile for an authenticated user id (GET /auth/me needs it
 * because JwtStrategy is stateless). A valid token whose user no longer exists
 * is a 401, not a 404 — the credential no longer maps to a real principal.
 */
@Injectable()
export class GetProfileUseCase {
  constructor(@Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort) {}

  async execute(userId: string): Promise<User> {
    const user = await this.users.findById(userId);
    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }
    return user;
  }
}
