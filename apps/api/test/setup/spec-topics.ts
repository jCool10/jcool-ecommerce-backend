import pino from 'pino';
import { createKafka } from '../../src/shared/messaging/kafka/kafka-client.factory';
import { provisionTopics } from '../../src/shared/messaging/kafka/provision-topics';

const provisioned = new Map<string, Promise<void>>();

/** Once per broker and prefix in a worker process: every app of a spec file shares both. */
export function provisionSpecTopics(brokers: string, prefix: string): Promise<void> {
  const key = `${brokers}|${prefix}`;
  let done = provisioned.get(key);
  if (!done) {
    done = provision(brokers, prefix);
    provisioned.set(key, done);
    done.catch(() => provisioned.delete(key));
  }
  return done;
}

/** For a broker replaced at the same address, which the cache would otherwise skip. */
export function reprovisionSpecTopics(brokers: string, prefix: string): Promise<void> {
  provisioned.delete(`${brokers}|${prefix}`);
  return provisionSpecTopics(brokers, prefix);
}

async function provision(brokers: string, prefix: string): Promise<void> {
  const admin = createKafka(
    { brokers: brokers.split(','), clientId: 'e2e-provisioner' },
    pino({ level: 'warn' }),
  ).admin();
  await admin.connect();
  try {
    await provisionTopics(admin, prefix);
  } finally {
    await admin.disconnect();
  }
}
