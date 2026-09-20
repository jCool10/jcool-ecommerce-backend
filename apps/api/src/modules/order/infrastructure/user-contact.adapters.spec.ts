import { useFakeClock } from '@jcool/testing/fake-clock';
import type { UserFacade } from '@modules/user/application/public/user-facade.port';
import { PermanentError } from '@shared/messaging/errors';
import { DownstreamUnavailableError } from '@jcool/platform/resilience';
import type { UserServiceClient, UserSummary } from '@shared/user-service/user-service.client';
import type { UserContactPort } from '../application/ports/user-contact.port';
import { LocalUserContactAdapter, RemoteUserContactAdapter, UserNotYetInDirectoryError } from './user-contact.adapters';

const USER_ID = '0199a3b2-7c4d-8e5f-9a0b-1c2d3e4f5a6b';
const SUMMARY: UserSummary = { id: USER_ID, email: 'buyer@example.com' };
const NOW = new Date('2026-09-19T12:00:00.000Z');
const GRACE_MS = 10 * 60_000;
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

describe('LocalUserContactAdapter', () => {
  const build = (summary: UserSummary | null) => {
    const getUserSummary = vi
      .fn<UserFacade['getUserSummary']>()
      .mockResolvedValue(summary && { ...summary, role: 'CUSTOMER' });
    const adapter: UserContactPort = new LocalUserContactAdapter({ getUserSummary });
    return { adapter, getUserSummary };
  };

  it("reads the user's address outside any transaction", async () => {
    const { adapter, getUserSummary } = build(SUMMARY);

    await expect(adapter.find(USER_ID, NOW)).resolves.toEqual({ email: SUMMARY.email });
    expect(getUserSummary).toHaveBeenCalledWith(USER_ID);
  });

  // The local table is the source of truth, so a missing row is final however recent the event.
  it('answers null for a user that does not exist', async () => {
    await expect(build(null).adapter.find(USER_ID, NOW)).resolves.toBeNull();
  });
});

describe('RemoteUserContactAdapter', () => {
  useFakeClock(NOW);

  const build = () => {
    const userSummary = vi.fn<UserServiceClient['userSummary']>();
    return { adapter: new RemoteUserContactAdapter({ userSummary }, GRACE_MS), userSummary };
  };

  it("maps the user-service's answer onto a contact", async () => {
    const { adapter, userSummary } = build();
    userSummary.mockResolvedValue(SUMMARY);

    await expect(adapter.find(USER_ID, minutesAgo(1))).resolves.toEqual({ email: SUMMARY.email });
    expect(userSummary).toHaveBeenCalledWith(USER_ID);
  });

  it.each([
    ['a timeout', new DownstreamUnavailableError('user-service', 'timeout')],
    ['an open circuit', new DownstreamUnavailableError('user-service', 'open')],
    ['a server error', new Error('user-service answered 503')],
  ])('lets %s through as retryable', async (_case, failure) => {
    const { adapter, userSummary } = build();
    userSummary.mockRejectedValue(failure);

    const lookup = adapter.find(USER_ID, minutesAgo(1));

    await expect(lookup).rejects.toBe(failure);
    await expect(lookup).rejects.not.toBeInstanceOf(PermanentError);
  });

  // A directory restored from a copy taken just before the cutover lacks the newest sign-ups for a while.
  it('reads an unknown user as "not yet" while the event is younger than the grace window', async () => {
    const { adapter, userSummary } = build();
    userSummary.mockResolvedValue(null);

    const lookup = adapter.find(USER_ID, minutesAgo(9));

    await expect(lookup).rejects.toBeInstanceOf(UserNotYetInDirectoryError);
    await expect(lookup).rejects.not.toBeInstanceOf(PermanentError);
  });

  it('reads an unknown user as gone once the event has outlived the window', async () => {
    const { adapter, userSummary } = build();
    userSummary.mockResolvedValue(null);

    await expect(adapter.find(USER_ID, minutesAgo(10))).resolves.toBeNull();
  });
});
