import { DynamicModule, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import configuration from './configuration';
import { validate, validateUser } from './env.validation';

/**
 * Both modules are dynamic on purpose. `NestConfigModule.forRoot` reads the dotenv file and runs
 * the schema the moment it is called, so declaring it inside `@Module({ imports: [...] })` would
 * run it while this file is being imported — and importing either class would then validate BOTH
 * apps' schemas. user-service would refuse to boot on commerce-core's DATABASE_URL.
 */
@Module({})
export class ConfigModule {
  static forRoot(): DynamicModule {
    return {
      module: ConfigModule,
      imports: [
        NestConfigModule.forRoot({
          isGlobal: true,
          validate,
          load: [configuration],
          envFilePath: '.env',
        }),
      ],
    };
  }
}

/**
 * Different schema, different file: the issuer requires its private key, its bucket key and its own
 * database URL, and reads `.env.user` so a local run cannot inherit commerce-core's values.
 */
@Module({})
export class UserConfigModule {
  static forRoot(): DynamicModule {
    return {
      module: UserConfigModule,
      imports: [
        NestConfigModule.forRoot({
          isGlobal: true,
          validate: validateUser,
          load: [configuration],
          envFilePath: '.env.user',
        }),
      ],
    };
  }
}
