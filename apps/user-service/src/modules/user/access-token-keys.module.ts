import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { durationToMs } from '@jcool/kernel';
import { ACCESS_TOKEN_SIGNER } from './application/ports';
import { Es256AccessTokenSigner } from './infrastructure/es256-access-token.signer';
import { Es256SigningKeys } from './infrastructure/es256-signing-keys';

@Module({
  providers: [
    {
      provide: Es256SigningKeys,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        Es256SigningKeys.parse(
          config.getOrThrow<string>('auth.es256PrivateKeys'),
          config.getOrThrow<string>('auth.es256ActiveKid'),
        ),
    },
    {
      provide: ACCESS_TOKEN_SIGNER,
      inject: [Es256SigningKeys, ConfigService],
      useFactory: (keys: Es256SigningKeys, config: ConfigService) =>
        new Es256AccessTokenSigner(keys, {
          issuer: config.getOrThrow<string>('auth.issuer'),
          audience: config.getOrThrow<string>('auth.audience'),
          expiresIn: Math.floor(durationToMs(config.getOrThrow<string>('auth.jwtAccessTtl')) / 1000),
        }),
    },
  ],
  exports: [Es256SigningKeys, ACCESS_TOKEN_SIGNER],
})
export class AccessTokenKeysModule {}
