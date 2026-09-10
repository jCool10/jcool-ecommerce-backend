import { describe, expect, it } from 'vitest';
import { NODE_ID_MAX } from '../node-ids';
import { UnknownServicePoolError } from './lease.errors';
import { parseServicePools, poolSizeFor } from './service-pools';

const MAX_POOL_SIZE = NODE_ID_MAX + 1;

describe('parseServicePools', () => {
  it('reads name:size pairs', () => {
    expect([...parseServicePools('user:1023,scripts:4')]).toEqual([
      ['user', 1023],
      ['scripts', 4],
    ]);
  });

  it('tolerates whitespace around entries', () => {
    expect([...parseServicePools(' user:2 , scripts:1 ,')]).toEqual([
      ['user', 2],
      ['scripts', 1],
    ]);
  });

  it.each(['user', 'user:', ':3', 'User:3', 'user_service:3', 'user:-1', 'user:2.5'])(
    'refuses malformed entry %s',
    (raw) => {
      expect(() => parseServicePools(raw)).toThrow(/not "name:size"/);
    },
  );

  it('refuses an empty declaration', () => {
    expect(() => parseServicePools(' , ')).toThrow(/no pools/);
  });

  it('refuses a duplicate name rather than letting the last one win', () => {
    expect(() => parseServicePools('user:2,user:900')).toThrow(/twice/);
  });

  it('accepts a pool of exactly the addressable range', () => {
    expect(parseServicePools(`user:${MAX_POOL_SIZE}`).get('user')).toBe(MAX_POOL_SIZE);
  });

  // The cap is what keeps UNLEASED_NODE_ID out of every pool: the in-process writer that cannot
  // lease mints under it, so no leaseholder may ever be handed the same id.
  it('refuses a pool that would reach the held-back node', () => {
    expect(() => parseServicePools(`user:${MAX_POOL_SIZE + 1}`)).toThrow(new RegExp(`between 1 and ${MAX_POOL_SIZE}`));
  });

  it('refuses a pool of zero', () => {
    expect(() => parseServicePools('user:0')).toThrow(/between 1 and/);
  });
});

describe('poolSizeFor', () => {
  const pools = parseServicePools('user:1023,scripts:4');

  it('returns the declared size', () => {
    expect(poolSizeFor(pools, 'scripts')).toBe(4);
  });

  // Acquire seeds a pool on first contact, so this has to throw before any statement runs —
  // otherwise a typo mints a pool of its own and the two halves of the fleet never see each other.
  it('refuses an undeclared service and names the ones that exist', () => {
    expect(() => poolSizeFor(pools, 'usr')).toThrow(UnknownServicePoolError);
    expect(() => poolSizeFor(pools, 'usr')).toThrow(/user, scripts/);
  });
});
