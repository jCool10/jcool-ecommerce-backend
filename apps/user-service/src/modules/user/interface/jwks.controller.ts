import { Controller, Get, Header } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { JSONWebKeySet } from 'jose';
import { Public } from '@jcool/platform/rbac';
import { ACCOUNT_THROTTLER, DEFAULT_THROTTLER } from '@jcool/platform/throttler';
import { Es256SigningKeys } from '../infrastructure/es256-signing-keys';

// A static document is cheaper to serve than a throttle check is to run.
@ApiExcludeController()
@Public()
@SkipThrottle({ [DEFAULT_THROTTLER]: true, [ACCOUNT_THROTTLER]: true })
@Controller('.well-known')
export class JwksController {
  constructor(private readonly keys: Es256SigningKeys) {}

  // Short enough that a key added ahead of a rotation reaches verifiers well before it signs.
  @Get('jwks.json')
  @Header('Cache-Control', 'public, max-age=300')
  jwks(): JSONWebKeySet {
    return this.keys.jwks;
  }
}
