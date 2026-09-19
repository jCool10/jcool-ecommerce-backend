import type { SessionEpochPort, SessionEpochPublisherPort } from '../ports';
import { FillSessionEpochUseCase } from './fill-session-epoch.use-case';

function epochs(current: number | null): SessionEpochPort {
  return { current: () => Promise.resolve(current), bump: () => Promise.reject(new Error('unused')) };
}

describe('FillSessionEpochUseCase', () => {
  it('publishes the stored epoch and answers with what is now published', async () => {
    const publish = vi.fn<SessionEpochPublisherPort['publish']>().mockResolvedValue(6);

    await expect(new FillSessionEpochUseCase(epochs(4), { publish }).execute('u1')).resolves.toBe(6);
    expect(publish).toHaveBeenCalledExactlyOnceWith('u1', 4);
  });

  it('answers null for an unknown user and publishes nothing', async () => {
    const publish = vi.fn<SessionEpochPublisherPort['publish']>();

    await expect(new FillSessionEpochUseCase(epochs(null), { publish }).execute('ghost')).resolves.toBeNull();
    expect(publish).not.toHaveBeenCalled();
  });
});
