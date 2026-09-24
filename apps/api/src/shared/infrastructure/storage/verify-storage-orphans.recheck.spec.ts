import { describe, expect, it } from 'vitest';
import { recheckCandidates } from './verify-storage-orphans.recheck';

describe('recheckCandidates', () => {
  it('drops a candidate whose row appeared after the snapshot', async () => {
    const landedMidScan = 'media/landed-mid-scan.png';

    const orphans = await recheckCandidates([landedMidScan, 'media/orphan.png'], (chunk) =>
      Promise.resolve(chunk.filter((key) => key === landedMidScan)),
    );

    expect(orphans).toEqual(['media/orphan.png']);
  });

  it('re-checks in bounded chunks and keeps what every chunk found', async () => {
    const keys = Array.from({ length: 2001 }, (_, index) => `media/object-${index}.png`);
    const known = new Set([keys[0], keys[1000], keys[2000]]);
    const chunks: string[][] = [];

    const orphans = await recheckCandidates(keys, (chunk) => {
      chunks.push(chunk);
      return Promise.resolve(chunk.filter((key) => known.has(key)));
    });

    expect(chunks.map((chunk) => chunk.length)).toEqual([1000, 1000, 1]);
    expect(orphans).toEqual(keys.filter((key) => !known.has(key)));
  });
});
