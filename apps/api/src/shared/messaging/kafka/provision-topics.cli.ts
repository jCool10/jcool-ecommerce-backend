/**
 * Create the Kafka topics the outbox publishes to, and check the partition count of those that exist:
 *   npm run messaging:provision-topics
 * In a deployed container, the compiled twin:
 *   npm run messaging:provision-topics:prod
 *
 * Run by hand when a topic is added or changed, never from preDeploy: there, a broken broker would block
 * every api deploy, rollbacks and hotfixes included. Configs are applied on create only; checking them on
 * an existing topic is a RUNBOOK step.
 */
import 'dotenv/config';
import { KafkaJS } from '@confluentinc/kafka-javascript';
import pino from 'pino';
import configuration from '@shared/config/configuration';
import { createKafka } from './kafka-client.factory';
import { provisionTopics } from './provision-topics';

// Covers connect and every admin call. Neither a failure nor the deadline waits for disconnect(): the
// native client can hold the event loop open against a broker that never answers, or block it outright.
const PROVISION_TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
  const { kafka } = configuration();
  console.log(`provisioning topics with prefix "${kafka.prefix}" on ${kafka.brokers.join(',') || '(none)'}`);

  const admin = createKafka(kafka, pino({ level: 'warn' })).admin();
  await admin.connect();
  const { created, existing } = await provisionTopics(admin, kafka.prefix);
  for (const topic of created) console.log(`created  ${topic}`);
  for (const topic of existing) console.log(`exists   ${topic}`);
  console.log(`\ncreated: ${created.length}   existing with matching partitions: ${existing.length}`);
  await admin.disconnect();
}

// createTopics folds each topic's broker error into one aggregate whose own message names none of them.
function explain(error: unknown): string {
  if (error instanceof KafkaJS.KafkaJSAggregateError) {
    const causes = error.errors.map((cause) =>
      cause instanceof KafkaJS.KafkaJSCreateTopicError ? `  ${cause.topic}: ${cause.message}` : `  ${String(cause)}`,
    );
    return [error.message, ...causes].join('\n');
  }
  return error instanceof Error ? error.message : String(error);
}

const deadline = setTimeout(() => {
  console.error(`no answer from the broker within ${PROVISION_TIMEOUT_MS / 1000}s`);
  process.exit(1);
}, PROVISION_TIMEOUT_MS);

main().then(
  () => clearTimeout(deadline),
  (error: unknown) => {
    console.error(explain(error));
    process.exit(1);
  },
);
