import { useFakeClock } from '@jcool/testing/fake-clock';
import { PermanentError } from '@shared/messaging/errors';
import type { UserServiceClient } from '@shared/user-service/user-service.client';
import { RemoteUserContactAdapter, UserNotYetInDirectoryError } from './user-contact.adapters';

const USER_ID = '0199a3b2-7c4d-8e5f-9a0b-1c2d3e4f5a6b';
const NOW = new Date('2026-09-19T12:00:00.000Z');
const GRACE_MS = 10 * 60_000;
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

describe('RemoteUserContactAdapter', () => {
  useFakeClock(NOW);

  const build = () => {
    const userSummary = vi.fn<UserServiceClient['userSummary']>();
    return { adapter: new RemoteUserContactAdapter({ userSummary }, GRACE_MS), userSummary };
  };

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
