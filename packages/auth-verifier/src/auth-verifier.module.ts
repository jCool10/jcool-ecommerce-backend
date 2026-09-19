import { type DynamicModule, type InjectionToken, Module, type ModuleMetadata } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { RolesGuard } from '@jcool/platform/rbac';
import { AccessTokenVerifier } from './access-token.verifier';
import { AUTH_VERIFIER_OPTIONS, type AuthVerifierOptions } from './auth-verifier.options';
import { JwtAuthGuard } from './jwt-auth.guard';

export interface AuthVerifierModuleOptions {
  /** Must export SESSION_EPOCH and TOKEN_DENYLIST. */
  imports?: ModuleMetadata['imports'];
  inject?: InjectionToken[];
  useFactory: (...args: never[]) => AuthVerifierOptions | Promise<AuthVerifierOptions>;
}

/**
 * Nest runs global guards in module-scan order, so import this after ThrottlerSecurityModule: a flood
 * is shed before it costs a signature check, and a wrong bearer over the limit answers 429.
 */
@Module({})
export class AuthVerifierModule {
  static forRootAsync(options: AuthVerifierModuleOptions): DynamicModule {
    return {
      module: AuthVerifierModule,
      imports: options.imports ?? [],
      providers: [
        { provide: AUTH_VERIFIER_OPTIONS, inject: options.inject ?? [], useFactory: options.useFactory },
        AccessTokenVerifier,
        // Authenticate, then authorize.
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
      exports: [AccessTokenVerifier],
    };
  }
}
