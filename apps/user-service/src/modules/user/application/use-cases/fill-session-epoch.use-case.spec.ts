import { FakeSessionEpoch, FakeSessionEpochPublisher } from '../../testing/session-epoch.double';
import { FillSessionEpochUseCase } from './fill-session-epoch.use-case';

describe('FillSessionEpochUseCase', () => {
  // A fill racing a bump must not lower what the bump already published.
  it('publishes the stored epoch and answers with what is now published', async () => {
    const epochs = new FakeSessionEpoch();
    epochs.epochs.set('fresh', 4);
    epochs.epochs.set('ahead', 4);
    const publisher = new FakeSessionEpochPublisher();
    publisher.published.set('ahead', 6);
    const useCase = new FillSessionEpochUseCase(epochs, publisher);

    expect([await useCase.execute('fresh'), await useCase.execute('ahead')]).toEqual([4, 6]);
    expect(publisher.published).toEqual(
      new Map([
        ['ahead', 6],
        ['fresh', 4],
      ]),
    );
  });
});
