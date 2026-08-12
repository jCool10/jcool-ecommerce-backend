import { Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import configuration from './configuration';
import { validate } from './env.validation';

// Global config module: validates env at startup (fail-fast) + exposes the typed factory.
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
