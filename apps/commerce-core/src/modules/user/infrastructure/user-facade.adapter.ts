import { Inject, Injectable } from '@nestjs/common';
import type { DrizzleTx } from '@shared/infrastructure/database';
import type { UserFacade, UserSummary } from '../application/public/user-facade.port';
import { USER_REPOSITORY, type UserRepositoryPort } from '../application/ports';

@Injectable()
export class UserFacadeAdapter implements UserFacade {
  constructor(@Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort) {}

  async getUserSummary(id: string, tx?: DrizzleTx): Promise<UserSummary | null> {
    const user = await this.users.findById(id, tx);
    return user ? { id: user.id, email: user.email, role: user.role } : null;
  }
}
