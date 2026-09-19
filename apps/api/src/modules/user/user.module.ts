import { Module } from '@nestjs/common';
import { IdentityModule } from '@shared/identity/identity.module';
import { PASSWORD_HASHER, USER_REPOSITORY } from './application/ports';
import { USER_FACADE } from './application/public/user-facade.port';
import {
  Argon2PasswordHasher,
  DrizzleUserRepository,
  IdentityBucketKeyVerifier,
  UserFacadeAdapter,
} from './infrastructure';

/** IdentityModule is imported because the repository mints its own row ids. */
@Module({
  imports: [IdentityModule],
  providers: [
    { provide: USER_REPOSITORY, useClass: DrizzleUserRepository },
    { provide: PASSWORD_HASHER, useClass: Argon2PasswordHasher },
    // Boot-time check on the key behind those ids; nothing injects it, it only runs.
    IdentityBucketKeyVerifier,
    { provide: USER_FACADE, useClass: UserFacadeAdapter },
  ],
  exports: [USER_REPOSITORY, PASSWORD_HASHER, USER_FACADE],
})
export class UserModule {}
