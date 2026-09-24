import { UnauthorizedException } from '@nestjs/common';
import { FakeUserRepository } from '../../testing/user-repository.double';
import { GetProfileUseCase } from './get-profile.use-case';

describe('GetProfileUseCase', () => {
  it('throws 401 when the token is valid but the user no longer exists', async () => {
    await expect(new GetProfileUseCase(new FakeUserRepository()).execute('ghost-user')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
