import { Module } from '@nestjs/common';
import { IdentityModule } from '@shared/identity/identity.module';
import { PASSWORD_HASHER, USER_REPOSITORY } from './application/ports';
import { Argon2PasswordHasher, DrizzleUserRepository, IdentityBucketKeyVerifier } from './infrastructure';

/** User persistence foundation — repository + password hasher behind DI tokens, exported so the auth layer injects the ports without depending on the adapters. Imports IdentityModule because the repository mints its own row ids. */
@Module({
  imports: [IdentityModule],
  providers: [
    { provide: USER_REPOSITORY, useClass: DrizzleUserRepository },
    { provide: PASSWORD_HASHER, useClass: Argon2PasswordHasher },
    // Boot-time check on the key behind those ids. It sits in this context because the tables it
    // reads are this context's; nothing injects it, it only runs.
    IdentityBucketKeyVerifier,
  ],
  exports: [USER_REPOSITORY, PASSWORD_HASHER],
})
export class UserModule {}
