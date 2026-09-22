import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type AuthenticatedUser, IS_PUBLIC_KEY } from '@jcool/platform/rbac';
import { AccessTokenVerifier } from './access-token.verifier';

const BEARER = /^bearer\s+(\S+)$/i;

interface HttpRequest {
  headers: { authorization?: string };
  user?: AuthenticatedUser;
}

/** Global, so a route is protected unless `@Public()` opts it out: a forgotten decorator locks, never opens. */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly verifier: AccessTokenVerifier,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<HttpRequest>();
    const token = BEARER.exec(request.headers.authorization ?? '')?.[1];
    request.user = await this.verifier.verify(token);
    return true;
  }
}
