import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpStatus,
  Inject,
  Ip,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { Response } from 'express';
import { Public } from '@jcool/platform/rbac';
import { REFRESH_THROTTLE } from '@jcool/platform/throttler';
import { AUTH_AUDIT, type AuthAuditPort } from '../../application/ports';
import { EmailVerificationService, PasswordResetService } from '../../application/services';
import { ResetPasswordDto } from '../dto';
import {
  linkInvalidPage,
  resetPasswordFormPage,
  resetPasswordSuccessPage,
  sendHtmlPage,
  verifyEmailSuccessPage,
} from './auth-link-pages';

/** The mail link posts here as a plain form, so the fields arrive as `unknown`, not a typed DTO. */
interface ResetPasswordFormBody {
  token?: unknown;
  password?: unknown;
  confirmPassword?: unknown;
}

/**
 * The GET links `mailer.adapter.ts` sends: same use cases and validation as the JSON `/auth/*`
 * routes in `AuthController`, rendered as self-contained HTML for a browser tab instead of JSON.
 */
@ApiExcludeController()
@Controller('auth')
export class AuthLinkPagesController {
  constructor(
    private readonly emailVerification: EmailVerificationService,
    private readonly passwordReset: PasswordResetService,
    @Inject(AUTH_AUDIT) private readonly audit: AuthAuditPort,
  ) {}

  @Public()
  @Get('verify-email')
  @Throttle(REFRESH_THROTTLE)
  async verifyEmail(
    @Query('token') token: unknown,
    @Res() res: Response,
    @Ip() ip: string,
    @Headers('user-agent') userAgent?: string,
  ): Promise<void> {
    if (typeof token !== 'string') {
      sendHtmlPage(res, HttpStatus.BAD_REQUEST, linkInvalidPage());
      return;
    }
    try {
      const { userId } = await this.emailVerification.verify(token);
      this.audit.record({ event: 'email.verified', outcome: 'success', userId, ip, userAgent });
      sendHtmlPage(res, HttpStatus.OK, verifyEmailSuccessPage());
    } catch (error) {
      if (!(error instanceof BadRequestException)) throw error;
      sendHtmlPage(res, HttpStatus.BAD_REQUEST, linkInvalidPage());
    }
  }

  // Changes no state: the token is only consumed once the form below is submitted.
  @Public()
  @Get('reset-password')
  @Throttle(REFRESH_THROTTLE)
  resetPasswordForm(@Query('token') token: unknown, @Res() res: Response): void {
    if (typeof token !== 'string') {
      sendHtmlPage(res, HttpStatus.BAD_REQUEST, linkInvalidPage());
      return;
    }
    sendHtmlPage(res, HttpStatus.OK, resetPasswordFormPage(token));
  }

  // No SameSite cookie or ambient credential is involved — the token itself is the sole secret a
  // forged cross-site submit would need and doesn't have, so this needs no CSRF guard.
  @Public()
  @Post('reset-password/form')
  @Throttle(REFRESH_THROTTLE)
  async submitResetPasswordForm(
    @Body() body: ResetPasswordFormBody,
    @Res() res: Response,
    @Ip() ip: string,
    @Headers('user-agent') userAgent?: string,
  ): Promise<void> {
    const token = typeof body?.token === 'string' ? body.token : undefined;
    if (token === undefined) {
      sendHtmlPage(res, HttpStatus.BAD_REQUEST, linkInvalidPage());
      return;
    }
    const password = typeof body?.password === 'string' ? body.password : '';
    const confirmPassword = typeof body?.confirmPassword === 'string' ? body.confirmPassword : '';

    const violations = await validate(plainToInstance(ResetPasswordDto, { token, password }));
    if (violations.length > 0) {
      const message = violations.flatMap((violation) => Object.values(violation.constraints ?? {})).join(' ');
      sendHtmlPage(res, HttpStatus.BAD_REQUEST, resetPasswordFormPage(token, message || 'Invalid input.'));
      return;
    }
    if (password !== confirmPassword) {
      sendHtmlPage(res, HttpStatus.BAD_REQUEST, resetPasswordFormPage(token, 'Passwords do not match.'));
      return;
    }

    try {
      const { userId } = await this.passwordReset.reset(token, password);
      this.audit.record({ event: 'password.reset', outcome: 'success', userId, ip, userAgent });
      sendHtmlPage(res, HttpStatus.OK, resetPasswordSuccessPage());
    } catch (error) {
      if (!(error instanceof BadRequestException)) throw error;
      sendHtmlPage(res, HttpStatus.BAD_REQUEST, linkInvalidPage());
    }
  }
}
