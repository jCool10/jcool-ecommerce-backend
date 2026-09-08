import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { User } from '../../domain/entities/user.entity';
import { USER_REPOSITORY, type UserRepositoryPort } from '../ports';

/** A valid token whose user no longer exists is a 401, not a 404. */
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
