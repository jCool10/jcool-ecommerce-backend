import { Module } from '@nestjs/common';
import { PASSWORD_HASHER } from './application/ports/password-hasher.port';
import { USER_REPOSITORY } from './application/ports/user-repository.port';
import { Argon2PasswordHasher } from './infrastructure/argon2-password-hasher';
import { DrizzleUserRepository } from './infrastructure/drizzle-user.repository';

/** User persistence foundation — repository + password hasher behind DI tokens, exported so the auth layer injects the ports without depending on the adapters. */
@Module({
  providers: [
    { provide: USER_REPOSITORY, useClass: DrizzleUserRepository },
    { provide: PASSWORD_HASHER, useClass: Argon2PasswordHasher },
  ],
  exports: [USER_REPOSITORY, PASSWORD_HASHER],
})
export class UserModule {}
