import { describe, expect, it, vi } from 'vitest';
import { useFakeClock } from '@shared/testing/fake-clock';
import { fakeConfigService } from '@shared/testing/fake-config.service';
import { RetentionSweepRegistry } from '@shared/retention';
import type {
  EmailVerificationTokenRepositoryPort,
  PasswordResetTokenRepositoryPort,
  RefreshTokenRepositoryPort,
} from '../ports';
import { SweepAuthTokensService } from './sweep-auth-tokens.service';

const DAY_MS = 86_400_000;
const NOW = new Date('2026-09-07T12:00:00.000Z');

const CONFIG: Record<string, unknown> = {
  'retention.authTokenGraceDays': 7,
  'retention.refreshTokenGraceDays': 30,
};

function build(overrides: Record<string, unknown> = {}) {
  const values = { ...CONFIG, ...overrides };
  const config = fakeConfigService(values);

  const emailVerification = { deleteSpentBefore: vi.fn().mockResolvedValue(0) };
  const passwordReset = { deleteSpentBefore: vi.fn().mockResolvedValue(0) };
  const refresh = { deleteCollectable: vi.fn().mockResolvedValue(0) };
  const registry = new RetentionSweepRegistry();

  const make = () =>
    new SweepAuthTokensService(
      emailVerification as unknown as EmailVerificationTokenRepositoryPort,
      passwordReset as unknown as PasswordResetTokenRepositoryPort,
      refresh as unknown as RefreshTokenRepositoryPort,
      config,
      registry,
    );
  return { make, registry, emailVerification, passwordReset, refresh };
}

const byName = (service: SweepAuthTokensService, name: string) => {
  const sweep = service.sweeps().find((s) => s.name === name);
  if (!sweep) throw new Error(`no sweep named ${name}`);
  return sweep;
};

describe('SweepAuthTokensService', () => {
  useFakeClock(NOW);

  it('registers each token table as its own sweep', () => {
    const { make, registry } = build();

    make().onModuleInit();

    expect(registry.names()).toEqual([
      'auth-tokens:email-verification',
      'auth-tokens:password-reset',
      'auth-tokens:refresh',
    ]);
  });

  it('collects a single-use token only once it is a grace period past its expiry', async () => {
    const { make, emailVerification, passwordReset } = build();
    const service = make();

    await byName(service, 'auth-tokens:email-verification').sweep(500);
    await byName(service, 'auth-tokens:password-reset').sweep(500);

    const cutoff = new Date(NOW.getTime() - 7 * DAY_MS);
    expect(emailVerification.deleteSpentBefore).toHaveBeenCalledWith(cutoff, 500);
    expect(passwordReset.deleteSpentBefore).toHaveBeenCalledWith(cutoff, 500);
  });

  // Expiry is age, revocation is evidence — collecting a revoked token on the expiry clock turns a
  // detected replay back into a successful refresh.
  it('gives a revoked refresh token a much longer horizon than an expired one', async () => {
    const { make, refresh } = build();

    await byName(make(), 'auth-tokens:refresh').sweep(500);

    const [expiredBefore, revokedBefore, limit] = refresh.deleteCollectable.mock.calls[0] as [Date, Date, number];
    expect(expiredBefore).toEqual(new Date(NOW.getTime() - 7 * DAY_MS));
    expect(revokedBefore).toEqual(new Date(NOW.getTime() - 30 * DAY_MS));
    expect(revokedBefore.getTime()).toBeLessThan(expiredBefore.getTime());
    expect(limit).toBe(500);
  });

  it('recomputes the cutoff on every tick rather than freezing the one it booted with', async () => {
    const { make, emailVerification } = build();
    const sweep = byName(make(), 'auth-tokens:email-verification');

    await sweep.sweep(500);
    vi.setSystemTime(new Date(NOW.getTime() + 3 * DAY_MS));
    await sweep.sweep(500);

    const [first] = emailVerification.deleteSpentBefore.mock.calls[0] as [Date];
    const [second] = emailVerification.deleteSpentBefore.mock.calls[1] as [Date];
    expect(second.getTime() - first.getTime()).toBe(3 * DAY_MS);
  });

  it('refuses to build without its grace periods, rather than sweeping on a NaN cutoff', () => {
    expect(() => build({ 'retention.authTokenGraceDays': undefined }).make()).toThrow(/Missing config key/);
    expect(() => build({ 'retention.refreshTokenGraceDays': undefined }).make()).toThrow(/Missing config key/);
  });
});
