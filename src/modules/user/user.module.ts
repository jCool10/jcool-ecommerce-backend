import { Module } from '@nestjs/common';
import { PASSWORD_HASHER, USER_REPOSITORY } from './application/ports';
import { Argon2PasswordHasher, DrizzleUserRepository } from './infrastructure';

/** User persistence foundation — repository + password hasher behind DI tokens, exported so the auth layer injects the ports without depending on the adapters. */
@Module({
  providers: [
    { provide: USER_REPOSITORY, useClass: DrizzleUserRepository },
    { provide: PASSWORD_HASHER, useClass: Argon2PasswordHasher },
  ],
  exports: [USER_REPOSITORY, PASSWORD_HASHER],
})
export class UserModule {}
