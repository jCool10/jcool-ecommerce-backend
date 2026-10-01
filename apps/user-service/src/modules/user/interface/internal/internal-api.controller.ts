import { Controller, Get, Inject, NotFoundException, Param, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { ParseSnowflakeIdPipe } from '@jcool/platform/interface';
import { Public } from '@jcool/platform/rbac';
import { ACCOUNT_THROTTLER, DEFAULT_THROTTLER } from '@jcool/platform/throttler';
import { USER_FACADE, type UserFacade, type UserSummary } from '../../application/public/user-facade.port';
import { FillSessionEpochUseCase } from '../../application/use-cases';
import { InternalApiTokenGuard } from './internal-api-token.guard';
import { secretFingerprint } from './secret-fingerprint';

/**
 * Service-to-service only; the gateway answers 404 for `/internal`. Unthrottled because every call
 * arrives from the same private address, where a per-IP limit would throttle the caller as a whole.
 * `@Public` only takes the user-token guard off: the service token below replaces it.
 */
@ApiExcludeController()
@Public()
@SkipThrottle({ [DEFAULT_THROTTLER]: true, [ACCOUNT_THROTTLER]: true })
@UseGuards(InternalApiTokenGuard)
@Controller('internal/v1')
export class InternalApiController {
  constructor(
    @Inject(USER_FACADE) private readonly users: UserFacade,
    private readonly fillSessionEpoch: FillSessionEpochUseCase,
    private readonly config: ConfigService,
  ) {}

  @Get('users/:id/summary')
  async userSummary(@Param('id', ParseSnowflakeIdPipe) id: string): Promise<UserSummary> {
    const summary = await this.users.getUserSummary(id);
    if (!summary) throw new NotFoundException();
    return summary;
  }

  @Get('sessions/:userId/epoch')
  async sessionEpoch(@Param('userId', ParseSnowflakeIdPipe) userId: string): Promise<{ epoch: number }> {
    const epoch = await this.fillSessionEpoch.execute(userId);
    if (epoch === null) throw new NotFoundException();
    return { epoch };
  }

  /**
   * What this process actually loaded, as fingerprints. A wrong secret fails in ways no smoke test
   * catches — CSRF cookies stop validating — so the precheck reads it back instead of trusting that
   * the right value was pasted into a dashboard.
   */
  @Get('cutover/digest')
  cutoverDigest(): Record<string, string> {
    return {
      csrfSecret: secretFingerprint(this.config.getOrThrow<string>('auth.csrfSecret')),
      accessTtl: this.config.getOrThrow<string>('auth.jwtAccessTtl'),
      issuer: this.config.getOrThrow<string>('auth.issuer'),
      audience: this.config.getOrThrow<string>('auth.audience'),
    };
  }
}
