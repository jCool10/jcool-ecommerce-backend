import { Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import configuration from './configuration';
import { validate, validateUser } from './env.validation';

@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      validate,
      load: [configuration],
      envFilePath: '.env',
    }),
  ],
})
export class ConfigModule {}

/**
 * Same defaults, stricter schema: the issuer additionally requires its private key, its bucket key
 * and its own database URL, and fails the boot without them.
 */
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      validate: validateUser,
      load: [configuration],
      envFilePath: '.env',
    }),
  ],
})
export class UserConfigModule {}
