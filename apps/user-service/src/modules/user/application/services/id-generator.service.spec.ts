import { RecordingIdGenerator } from '../../testing/id-generator.double';
import { IdGeneratorService } from './id-generator.service';

describe('IdGeneratorService', () => {
  it('mints one id per call', async () => {
    const ids = new RecordingIdGenerator();
    const idGeneratorService = new IdGeneratorService(ids);

    const first = await idGeneratorService.mintId();
    const second = await idGeneratorService.mintId();

    expect(first).not.toBe(second);
    expect(ids.requests).toEqual([1, 1]);
  });
});
