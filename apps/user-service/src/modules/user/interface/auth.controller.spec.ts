import { ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { Response } from 'express';
import { describe, expect, it } from 'vitest';
import type { AuthenticatedUser } from '@jcool/platform/rbac';
import type { AuthAuditRecord } from '../application/ports';
import type {
  AuthTokens,
  EmailVerificationService,
  PasswordResetService,
  SessionService,
} from '../application/services';
import type {
  ChangePasswordUseCase,
  ForgotPasswordUseCase,
  GetProfileUseCase,
  LoginUserUseCase,
  LogoutUserUseCase,
  RefreshTokensUseCase,
  RegisterUserUseCase,
  ResendVerificationUseCase,
} from '../application/use-cases';
import { User } from '../domain/entities/user.entity';
import { RecordingAuthAudit } from '../testing/recording-auth-audit.double';
import { AuthController } from './auth.controller';
import type { AuthCookieService } from './security';

const IP = '203.0.113.9';
const UA = 'vitest-agent';
const EMAIL = 'user@test.local';
const SESSION_ID = 'fam-9';
const TOKENS: AuthTokens = { accessToken: 'access', refreshToken: 'refresh', expiresIn: 300 };
// Routes behind a bearer token audit the caller; the rest audit whoever the service answers with.
const CURRENT: AuthenticatedUser = { userId: 'u1', role: 'CUSTOMER', jti: 'jti-1', exp: 9999999999 };
const ANSWERED_ID = 'u9';
const res = {} as Response;

const stub = <T>(methods: Partial<Record<keyof T, unknown>>): T => methods as unknown as T;

function controllerWith(overrides: { login?: () => Promise<AuthTokens>; revokeSession?: () => Promise<boolean> } = {}) {
  const audit = new RecordingAuthAudit();
  const cookies: string[] = [];
  const controller = new AuthController(
    stub<RegisterUserUseCase>({
      execute: () => Promise.resolve(new User(ANSWERED_ID, EMAIL, 'hash', 'CUSTOMER', new Date(), new Date())),
    }),
    stub<LoginUserUseCase>({ execute: overrides.login ?? (() => Promise.resolve(TOKENS)) }),
    stub<GetProfileUseCase>({}),
    stub<RefreshTokensUseCase>({ execute: () => Promise.resolve({ ...TOKENS, userId: ANSWERED_ID }) }),
    stub<LogoutUserUseCase>({ execute: () => Promise.resolve() }),
    stub<AuthCookieService>({ setSession: () => cookies.push('set'), clear: () => cookies.push('clear') }),
    audit,
    stub<EmailVerificationService>({ verify: () => Promise.resolve({ userId: ANSWERED_ID }) }),
    stub<ResendVerificationUseCase>({}),
    stub<PasswordResetService>({ reset: () => Promise.resolve({ userId: ANSWERED_ID }) }),
    stub<ForgotPasswordUseCase>({}),
    stub<ChangePasswordUseCase>({ execute: () => Promise.resolve() }),
    stub<SessionService>({
      revokeSession: overrides.revokeSession ?? (() => Promise.resolve(true)),
      revokeAll: () => Promise.resolve(),
    }),
  );
  return { controller, audit, cookies };
}

// The e2e tier checks responses and cookies, never the audit trail, so this is its only check.
describe('AuthController audit trail', () => {
  it('audits each successful route once, setting or clearing the session cookie', async () => {
    const routes: Record<string, (controller: AuthController) => Promise<unknown>> = {
      register: (c) => c.register({ email: EMAIL, password: 'pw' }, IP, UA),
      verifyEmail: (c) => c.verifyEmail({ token: 'raw-token' }, IP, UA),
      resetPassword: (c) => c.resetPassword({ token: 'raw-token', password: 'new-password' }, IP, UA),
      revokeSession: (c) => c.revokeSession(CURRENT, SESSION_ID, IP, UA),
      login: (c) => c.login({ email: EMAIL, password: 'pw' }, res, IP, UA),
      refresh: (c) => c.refresh('refresh', res, IP, UA),
      changePassword: (c) =>
        c.changePasswordRequest(CURRENT, { currentPassword: 'old-pw', newPassword: 'new-password' }, res, IP, UA),
      logoutAll: (c) => c.logoutAll(CURRENT, res, IP, UA),
      logout: (c) => c.logout(CURRENT, 'refresh', res, IP, UA),
    };

    const outcomes: Record<string, { audit: AuthAuditRecord[]; cookies: string[] }> = {};
    for (const [route, call] of Object.entries(routes)) {
      const { controller, audit, cookies } = controllerWith();
      await call(controller);
      outcomes[route] = { audit: audit.records, cookies };
    }

    const success = { outcome: 'success', ip: IP, userAgent: UA } as const;
    expect(outcomes).toEqual({
      register: { audit: [{ event: 'user.registered', ...success, userId: ANSWERED_ID, email: EMAIL }], cookies: [] },
      verifyEmail: { audit: [{ event: 'email.verified', ...success, userId: ANSWERED_ID }], cookies: [] },
      resetPassword: { audit: [{ event: 'password.reset', ...success, userId: ANSWERED_ID }], cookies: [] },
      revokeSession: {
        audit: [{ event: 'session.revoked', ...success, userId: 'u1', metadata: { sessionId: SESSION_ID } }],
        cookies: [],
      },
      login: { audit: [{ event: 'login.succeeded', ...success, email: EMAIL }], cookies: ['set'] },
      refresh: { audit: [{ event: 'token.refreshed', ...success, userId: ANSWERED_ID }], cookies: ['set'] },
      changePassword: { audit: [{ event: 'password.changed', ...success, userId: 'u1' }], cookies: ['clear'] },
      logoutAll: { audit: [{ event: 'logout.all', ...success, userId: 'u1' }], cookies: ['clear'] },
      logout: { audit: [{ event: 'logout', ...success, userId: 'u1' }], cookies: ['clear'] },
    });
  });

  it('audits a failed login by its cause and rethrows it unchanged, with no cookie', async () => {
    const failures: Record<string, Error> = {
      invalid_credentials: new UnauthorizedException('Invalid credentials'),
      email_not_verified: new ForbiddenException('Email not verified'),
      error: new Error('connection terminated'),
    };

    const outcomes = await Promise.all(
      Object.entries(failures).map(async ([reason, failure]) => {
        const { controller, audit, cookies } = controllerWith({ login: () => Promise.reject(failure) });
        const thrown = await controller.login({ email: EMAIL, password: 'pw' }, res, IP, UA).then(
          () => 'resolved',
          (error: unknown) => error,
        );
        return [reason, { rethrown: thrown === failure, audit: audit.records, cookies }] as const;
      }),
    );

    const failedLogin = (reason: string) => ({
      rethrown: true,
      audit: [{ event: 'login.failed', outcome: 'failure', email: EMAIL, ip: IP, userAgent: UA, reason }],
      cookies: [],
    });
    expect(Object.fromEntries(outcomes)).toEqual({
      invalid_credentials: failedLogin('invalid_credentials'),
      email_not_verified: failedLogin('email_not_verified'),
      error: failedLogin('error'),
    });
  });

  it("404s revoking a session that is not the caller's, and audits nothing", async () => {
    const { controller, audit } = controllerWith({ revokeSession: () => Promise.resolve(false) });

    await expect(controller.revokeSession(CURRENT, 'fam-unknown', IP, UA)).rejects.toBeInstanceOf(NotFoundException);
    expect(audit.records).toEqual([]);
  });
});
