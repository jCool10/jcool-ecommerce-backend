import { RecordingIdGenerator } from '../../testing/id-generator.double';
import { IdentityService } from './identity.service';

describe('IdentityService', () => {
  it('mints one id per call', async () => {
    const ids = new RecordingIdGenerator();
    const identity = new IdentityService(ids);

    const first = await identity.mintId();
    const second = await identity.mintId();

    expect(first).not.toBe(second);
    expect(ids.requests).toEqual([1, 1]);
  });
});
