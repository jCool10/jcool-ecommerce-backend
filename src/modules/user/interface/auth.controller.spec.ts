import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { Response } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AuthAuditPort, AuthAuditRecord } from '../application/ports/auth-audit.port';
import type { EmailVerificationService } from '../application/services/email-verification.service';
import type { PasswordResetService } from '../application/services/password-reset.service';
import type { SessionService } from '../application/services/session.service';
import type { ChangePasswordUseCase } from '../application/use-cases/change-password.use-case';
import type { ForgotPasswordUseCase } from '../application/use-cases/forgot-password.use-case';
import type { GetProfileUseCase } from '../application/use-cases/get-profile.use-case';
import type { LoginUserUseCase } from '../application/use-cases/login-user.use-case';
import type { LogoutUserUseCase } from '../application/use-cases/logout-user.use-case';
import type { RefreshTokensUseCase } from '../application/use-cases/refresh-tokens.use-case';
import type { RegisterUserUseCase } from '../application/use-cases/register-user.use-case';
import type { ResendVerificationUseCase } from '../application/use-cases/resend-verification.use-case';
import type { ActiveSession } from '../application/ports/refresh-token-repository.port';
import type { AuthTokens } from '../application/services/auth-tokens.service';
import { AuthController } from './auth.controller';
import type { AuthenticatedUser } from './decorators/current-user.decorator';
import type { AuthCookieService } from './security/auth-cookie.service';

// Verifies the controller emits the right audit event at each auth boundary —
// the one place with request context (IP/UA) and the success/failure outcome.
class MockAudit implements AuthAuditPort {
  readonly records: AuthAuditRecord[] = [];
  record(entry: AuthAuditRecord): void {
    this.records.push(entry);
  }
}

const IP = '203.0.113.9';
const UA = 'vitest-agent';
const TOKENS: AuthTokens = { accessToken: 'access', refreshToken: 'refresh', expiresIn: 300 };
const CURRENT: AuthenticatedUser = { userId: 'u1', role: 'CUSTOMER', jti: 'jti-1', exp: 9999999999 };
const res = {} as Response; // cookie service is mocked, so it never touches res

describe('AuthController (audit trail)', () => {
  let audit: MockAudit;
  let cookieCalls: { set: number; clear: number };
  let cookies: AuthCookieService;

  beforeEach(() => {
    audit = new MockAudit();
    cookieCalls = { set: 0, clear: 0 };
    cookies = {
      setSession: () => cookieCalls.set++,
      clear: () => cookieCalls.clear++,
    } as unknown as AuthCookieService;
  });

  // Build a controller with only the collaborators a given test needs.
  function build(over: {
    login?: LoginUserUseCase;
    register?: RegisterUserUseCase;
    refresh?: RefreshTokensUseCase;
    logout?: LogoutUserUseCase;
    emailVerification?: EmailVerificationService;
    resendVerification?: ResendVerificationUseCase;
    passwordReset?: PasswordResetService;
    forgotPassword?: ForgotPasswordUseCase;
    changePassword?: ChangePasswordUseCase;
    sessions?: SessionService;
  }): AuthController {
    const login = over.login ?? ({ execute: () => Promise.resolve(TOKENS) } as unknown as LoginUserUseCase);
    const register =
      over.register ??
      ({
        execute: () => Promise.resolve({ id: 'u1', email: 'user@test.local', role: 'CUSTOMER' }),
      } as unknown as RegisterUserUseCase);
    const refresh = over.refresh ?? ({ execute: () => Promise.resolve(TOKENS) } as unknown as RefreshTokensUseCase);
    const logout = over.logout ?? ({ execute: () => Promise.resolve() } as unknown as LogoutUserUseCase);
    const getProfile = { execute: () => Promise.reject(new Error('unused')) } as unknown as GetProfileUseCase;
    const emailVerification =
      over.emailVerification ??
      ({ verify: () => Promise.resolve({ userId: 'u1' }) } as unknown as EmailVerificationService);
    const resendVerification =
      over.resendVerification ?? ({ execute: () => Promise.resolve() } as unknown as ResendVerificationUseCase);
    const passwordReset =
      over.passwordReset ?? ({ reset: () => Promise.resolve({ userId: 'u1' }) } as unknown as PasswordResetService);
    const forgotPassword =
      over.forgotPassword ?? ({ execute: () => Promise.resolve() } as unknown as ForgotPasswordUseCase);
    const changePassword =
      over.changePassword ?? ({ execute: () => Promise.resolve() } as unknown as ChangePasswordUseCase);
    const sessions =
      over.sessions ??
      ({
        listActiveSessions: () => Promise.resolve([]),
        revokeSession: () => Promise.resolve(true),
        revokeAll: () => Promise.resolve(),
      } as unknown as SessionService);
    return new AuthController(
      register,
      login,
      getProfile,
      refresh,
      logout,
      cookies,
      audit,
      emailVerification,
      resendVerification,
      passwordReset,
      forgotPassword,
      changePassword,
      sessions,
    );
  }

  it('audits login.succeeded with request context and sets the session cookie', async () => {
    const controller = build({});

    await controller.login({ email: 'user@test.local', password: 'pw' }, res, IP, UA);

    expect(cookieCalls.set).toBe(1);
    expect(audit.records).toEqual([
      { event: 'login.succeeded', outcome: 'success', email: 'user@test.local', ip: IP, userAgent: UA },
    ]);
  });

  it('audits login.failed then rethrows the generic 401 (no session cookie)', async () => {
    const login = {
      execute: () => Promise.reject(new UnauthorizedException('Invalid credentials')),
    } as unknown as LoginUserUseCase;
    const controller = build({ login });

    await expect(controller.login({ email: 'user@test.local', password: 'bad' }, res, IP, UA)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(cookieCalls.set).toBe(0);
    expect(audit.records).toEqual([
      {
        event: 'login.failed',
        outcome: 'failure',
        email: 'user@test.local',
        ip: IP,
        userAgent: UA,
        reason: 'invalid_credentials',
      },
    ]);
  });

  it('audits logout with the subject and clears the session cookie', async () => {
    const controller = build({});

    await controller.logout(CURRENT, 'refresh', res, IP, UA);

    expect(cookieCalls.clear).toBe(1);
    expect(audit.records).toEqual([{ event: 'logout', outcome: 'success', userId: 'u1', ip: IP, userAgent: UA }]);
  });

  it('audits user.registered with the new account id + email', async () => {
    const controller = build({});

    await controller.register({ email: 'user@test.local', password: 'pw' }, IP, UA);

    expect(audit.records).toEqual([
      { event: 'user.registered', outcome: 'success', userId: 'u1', email: 'user@test.local', ip: IP, userAgent: UA },
    ]);
  });

  it('audits token.refreshed on a successful rotation', async () => {
    const controller = build({});

    await controller.refresh('refresh', res, IP, UA);

    expect(cookieCalls.set).toBe(1);
    expect(audit.records).toEqual([{ event: 'token.refreshed', outcome: 'success', ip: IP, userAgent: UA }]);
  });

  it('verifies an email token and audits email.verified with the subject', async () => {
    let verifiedToken: string | undefined;
    const emailVerification = {
      verify: (token: string) => {
        verifiedToken = token;
        return Promise.resolve({ userId: 'u9' });
      },
    } as unknown as EmailVerificationService;
    const controller = build({ emailVerification });

    await controller.verifyEmail({ token: 'raw-token' }, IP, UA);

    expect(verifiedToken).toBe('raw-token');
    expect(audit.records).toEqual([
      { event: 'email.verified', outcome: 'success', userId: 'u9', ip: IP, userAgent: UA },
    ]);
  });

  it('delegates resend to the use case (no controller-level audit — the service records the send)', async () => {
    let resentEmail: string | undefined;
    const resendVerification = {
      execute: (email: string) => {
        resentEmail = email;
        return Promise.resolve();
      },
    } as unknown as ResendVerificationUseCase;
    const controller = build({ resendVerification });

    await controller.resendVerificationEmail({ email: 'user@test.local' });

    expect(resentEmail).toBe('user@test.local');
    expect(audit.records).toEqual([]);
  });

  it('delegates forgot-password to the use case (no controller-level audit — the service records the request)', async () => {
    let requestedEmail: string | undefined;
    const forgotPassword = {
      execute: (email: string) => {
        requestedEmail = email;
        return Promise.resolve();
      },
    } as unknown as ForgotPasswordUseCase;
    const controller = build({ forgotPassword });

    await controller.forgotPasswordRequest({ email: 'user@test.local' });

    expect(requestedEmail).toBe('user@test.local');
    expect(audit.records).toEqual([]);
  });

  it('resets the password and audits password.reset with the subject', async () => {
    let resetArgs: { token: string; password: string } | undefined;
    const passwordReset = {
      reset: (token: string, password: string) => {
        resetArgs = { token, password };
        return Promise.resolve({ userId: 'u9' });
      },
    } as unknown as PasswordResetService;
    const controller = build({ passwordReset });

    await controller.resetPassword({ token: 'raw-token', password: 'new-password' }, IP, UA);

    expect(resetArgs).toEqual({ token: 'raw-token', password: 'new-password' });
    expect(audit.records).toEqual([
      { event: 'password.reset', outcome: 'success', userId: 'u9', ip: IP, userAgent: UA },
    ]);
  });

  it('changes the password, clears the cookie, and audits password.changed', async () => {
    let changeArgs: { userId: string; currentPassword: string; newPassword: string } | undefined;
    const changePassword = {
      execute: (input: { userId: string; currentPassword: string; newPassword: string }) => {
        changeArgs = input;
        return Promise.resolve();
      },
    } as unknown as ChangePasswordUseCase;
    const controller = build({ changePassword });

    await controller.changePasswordRequest(
      CURRENT,
      { currentPassword: 'old-pw', newPassword: 'new-password' },
      res,
      IP,
      UA,
    );

    expect(changeArgs).toEqual({ userId: 'u1', currentPassword: 'old-pw', newPassword: 'new-password' });
    expect(cookieCalls.clear).toBe(1);
    expect(audit.records).toEqual([
      { event: 'password.changed', outcome: 'success', userId: 'u1', ip: IP, userAgent: UA },
    ]);
  });

  it('logs out all sessions, clears the cookie, and audits logout.all', async () => {
    let revokedAllFor: string | undefined;
    const sessions = {
      listActiveSessions: () => Promise.resolve([]),
      revokeSession: () => Promise.resolve(true),
      revokeAll: (userId: string) => {
        revokedAllFor = userId;
        return Promise.resolve();
      },
    } as unknown as SessionService;
    const controller = build({ sessions });

    await controller.logoutAll(CURRENT, res, IP, UA);

    expect(revokedAllFor).toBe('u1');
    expect(cookieCalls.clear).toBe(1);
    expect(audit.records).toEqual([{ event: 'logout.all', outcome: 'success', userId: 'u1', ip: IP, userAgent: UA }]);
  });

  it('lists the caller’s active sessions, flagging the current one', async () => {
    const active: ActiveSession[] = [
      {
        id: 'fam-current',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        expiresAt: new Date('2026-01-08T00:00:00.000Z'),
        current: true,
      },
      {
        id: 'fam-other',
        createdAt: new Date('2026-01-02T00:00:00.000Z'),
        expiresAt: new Date('2026-01-09T00:00:00.000Z'),
        current: false,
      },
    ];
    let listedFor: { userId: string; token: string | null } | undefined;
    const sessions = {
      listActiveSessions: (userId: string, token: string | null) => {
        listedFor = { userId, token };
        return Promise.resolve(active);
      },
      revokeSession: () => Promise.resolve(true),
      revokeAll: () => Promise.resolve(),
    } as unknown as SessionService;
    const controller = build({ sessions });

    const result = await controller.listSessions(CURRENT, 'raw-refresh');

    expect(listedFor).toEqual({ userId: 'u1', token: 'raw-refresh' });
    expect(result).toEqual([
      {
        id: 'fam-current',
        createdAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2026-01-08T00:00:00.000Z',
        current: true,
      },
      { id: 'fam-other', createdAt: '2026-01-02T00:00:00.000Z', expiresAt: '2026-01-09T00:00:00.000Z', current: false },
    ]);
    expect(audit.records).toEqual([]); // a read is not an audited event
  });

  it('revokes a named session and audits session.revoked', async () => {
    let revokeArgs: { userId: string; id: string } | undefined;
    const sessions = {
      listActiveSessions: () => Promise.resolve([]),
      revokeSession: (userId: string, id: string) => {
        revokeArgs = { userId, id };
        return Promise.resolve(true);
      },
      revokeAll: () => Promise.resolve(),
    } as unknown as SessionService;
    const controller = build({ sessions });

    await controller.revokeSession(CURRENT, 'fam-9', IP, UA);

    expect(revokeArgs).toEqual({ userId: 'u1', id: 'fam-9' });
    expect(audit.records).toEqual([
      {
        event: 'session.revoked',
        outcome: 'success',
        userId: 'u1',
        ip: IP,
        userAgent: UA,
        metadata: { sessionId: 'fam-9' },
      },
    ]);
  });

  it('404s revoking a session that is not the caller’s, and audits nothing', async () => {
    const sessions = {
      listActiveSessions: () => Promise.resolve([]),
      revokeSession: () => Promise.resolve(false),
      revokeAll: () => Promise.resolve(),
    } as unknown as SessionService;
    const controller = build({ sessions });

    await expect(controller.revokeSession(CURRENT, 'fam-unknown', IP, UA)).rejects.toBeInstanceOf(NotFoundException);
    expect(audit.records).toEqual([]);
  });
});
