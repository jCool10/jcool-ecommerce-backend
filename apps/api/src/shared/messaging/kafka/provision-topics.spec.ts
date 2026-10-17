import { describe, expect, it, vi } from 'vitest';
import { TOPIC_SPEC } from './kafka-topology';
import { provisionTopics, TopicLayoutDriftError, type ProvisioningAdmin } from './provision-topics';

const ALL = ['jcool.order.events', 'jcool.payment.events', 'jcool.catalog.events'];
const configEntries = Object.entries(TOPIC_SPEC.configs).map(([name, value]) => ({ name, value }));

/** `onBroker` is what the broker holds; `listed` is what a possibly stale listTopics returns. */
function fakeAdmin(onBroker: Record<string, number>, listed = Object.keys(onBroker)) {
  const partitions = (count: number) =>
    Array.from({ length: count }, (_, partitionId) => ({
      partitionErrorCode: 0,
      partitionId,
      leader: 1,
      replicas: [1],
      isr: [1],
    }));
  return {
    listTopics: vi.fn<ProvisioningAdmin['listTopics']>(() =>
      Promise.resolve(['__consumer_offsets', 'other.topic', ...listed]),
    ),
    fetchTopicMetadata: vi.fn<ProvisioningAdmin['fetchTopicMetadata']>(({ topics = [] } = {}) =>
      Promise.resolve(topics.map((name) => ({ name, partitions: partitions(onBroker[name]) }))),
    ),
    // Like the client: false when the topic already exists.
    createTopics: vi.fn<ProvisioningAdmin['createTopics']>(({ topics }) =>
      Promise.resolve(topics.every(({ topic }) => !(topic in onBroker))),
    ),
  } satisfies ProvisioningAdmin;
}

const createdTopics = (admin: ReturnType<typeof fakeAdmin>) =>
  admin.createTopics.mock.calls.flatMap(([{ topics }]) => topics);

describe('provisionTopics', () => {
  it('creates the missing topics with the partition count and every config entry of the spec', async () => {
    const admin = fakeAdmin({});

    await expect(provisionTopics(admin, 'jcool')).resolves.toEqual({ created: ALL, existing: [] });
    expect(createdTopics(admin)).toEqual(ALL.map((topic) => ({ topic, numPartitions: 3, configEntries })));
  });

  it('creates nothing when every topic exists with the right partition count', async () => {
    const admin = fakeAdmin(Object.fromEntries(ALL.map((topic) => [topic, 3])));

    await expect(provisionTopics(admin, 'jcool')).resolves.toEqual({ created: [], existing: ALL });
    expect(admin.createTopics).not.toHaveBeenCalled();
  });

  it('creates only what is missing', async () => {
    const admin = fakeAdmin({ 'jcool.payment.events': 3 });

    await expect(provisionTopics(admin, 'jcool')).resolves.toEqual({
      created: ['jcool.order.events', 'jcool.catalog.events'],
      existing: ['jcool.payment.events'],
    });
    expect(createdTopics(admin).map(({ topic }) => topic)).toEqual(['jcool.order.events', 'jcool.catalog.events']);
  });

  it('refuses an existing topic whose partition count drifted, before creating anything', async () => {
    const admin = fakeAdmin({ 'jcool.order.events': 6 });

    const error = await provisionTopics(admin, 'jcool').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TopicLayoutDriftError);
    expect(error).toMatchObject({ topic: 'jcool.order.events', expectedPartitions: 3, actualPartitions: 6 });
    expect((error as Error).message).toBe('Topic jcool.order.events has 6 partitions, expected 3');
    expect(admin.createTopics).not.toHaveBeenCalled();
  });

  it('checks a topic that appeared after the listing like any existing one', async () => {
    const admin = fakeAdmin({ 'jcool.payment.events': 3 }, []);

    await expect(provisionTopics(admin, 'jcool')).resolves.toEqual({
      created: ['jcool.order.events', 'jcool.catalog.events'],
      existing: ['jcool.payment.events'],
    });
    expect(admin.fetchTopicMetadata).toHaveBeenCalledExactlyOnceWith({ topics: ['jcool.payment.events'] });
  });

  it('refuses a drifted topic even when the listing missed it', async () => {
    const admin = fakeAdmin({ 'jcool.payment.events': 1 }, []);

    await expect(provisionTopics(admin, 'jcool')).rejects.toMatchObject({
      topic: 'jcool.payment.events',
      actualPartitions: 1,
    });
  });

  it('refuses a prefix the app would reject, such as an empty KAFKA_PREFIX', async () => {
    const admin = fakeAdmin({});

    await expect(provisionTopics(admin, '')).rejects.toThrow('KAFKA_PREFIX "" is not a valid topic prefix');
    expect(admin.listTopics).not.toHaveBeenCalled();
  });

  it('only looks at topics under its own prefix', async () => {
    const admin = fakeAdmin({ 'e2e.order.events': 1 });

    await expect(provisionTopics(admin, 'jcool')).resolves.toMatchObject({ existing: [] });
    expect(admin.fetchTopicMetadata).not.toHaveBeenCalled();
  });
});
