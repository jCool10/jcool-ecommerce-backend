import { ServiceUnavailableException } from '@nestjs/common';
import type { RedisService } from '@jcool/platform/redis';
import { fakeMetricsPort } from '@jcool/testing/fake-metrics-port';
import { RedisSessionEpochReader, RedisTokenDenylistReader } from './redis-session-state.readers';

const USER_ID = '0199a3b2-7c4d-8e5f-9a0b-1c2d3e4f5a6b';

/** Answers from `replies` and records every command, so a write cannot slip past the assertions. */
function recordingRedis(replies: Record<string, (key: string) => unknown>) {
  const commands: Array<[string, ...unknown[]]> = [];
  const client = new Proxy(
    {},
    {
      get:
        (_target, command: string) =>
        (...args: unknown[]) => {
          commands.push([command, ...args]);
          const reply = replies[command];
          return reply ? Promise.resolve(reply(args[0] as string)) : Promise.reject(new Error(`unexpected ${command}`));
        },
    },
  );
  return { redis: { getClient: () => client } as unknown as RedisService, commands };
}

describe('RedisSessionEpochReader', () => {
  const build = (stored: string | null, sessionEpoch = vi.fn<(userId: string) => Promise<number | null>>()) => {
    const { redis, commands } = recordingRedis({ get: () => stored });
    const metrics = fakeMetricsPort();
    return { reader: new RedisSessionEpochReader(redis, { sessionEpoch }, metrics), commands, metrics, sessionEpoch };
  };

  it('answers from the published key', async () => {
    const { reader, commands, metrics, sessionEpoch } = build('2');

    await expect(reader.current(USER_ID)).resolves.toBe(2);
    expect(commands).toEqual([['get', `auth:epoch:${USER_ID}`]]);
    expect(sessionEpoch).not.toHaveBeenCalled();
    expect(metrics.recordSessionEpochLookup).toHaveBeenCalledWith('hit');
  });

  it('reads through to the user-service on a miss, and leaves the fill to it', async () => {
    const { reader, commands, metrics, sessionEpoch } = build(null);
    sessionEpoch.mockResolvedValue(5);

    await expect(reader.current(USER_ID)).resolves.toBe(5);
    expect(sessionEpoch).toHaveBeenCalledWith(USER_ID);
    expect(commands.map(([command]) => command)).toEqual(['get']);
    expect(metrics.recordSessionEpochLookup).toHaveBeenCalledWith('miss');
  });

  // Defaulting to 0 would revive every token revoked before the key went missing.
  it('answers "no such user" when the user-service has none', async () => {
    const { reader, sessionEpoch } = build(null);
    sessionEpoch.mockResolvedValue(null);

    await expect(reader.current(USER_ID)).resolves.toBeNull();
  });

  it('answers 503 when the read-through fails, rather than letting the token through', async () => {
    const { reader, sessionEpoch } = build(null);
    const outage = new Error('user-service down');
    sessionEpoch.mockRejectedValue(outage);

    const failure = reader.current(USER_ID);

    await expect(failure).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(failure).rejects.toMatchObject({ cause: outage });
  });

  // NaN compares false against every epoch claim, so passing it on would accept revoked tokens.
  it.each(['', 'abc', '1.5', '-1'])('refuses a stored value of %j', async (stored) => {
    const { reader } = build(stored);

    await expect(reader.current(USER_ID)).rejects.toThrow(/epoch/);
  });
});

describe('RedisTokenDenylistReader', () => {
  it.each([
    [1, true],
    [0, false],
  ])('reads EXISTS %i as denylisted=%s', async (exists, denylisted) => {
    const { redis, commands } = recordingRedis({ exists: () => exists });

    await expect(new RedisTokenDenylistReader(redis).isDenylisted('jti-1')).resolves.toBe(denylisted);
    expect(commands).toEqual([['exists', 'auth:denylist:jti-1']]);
  });
});
