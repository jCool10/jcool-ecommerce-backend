import { UnroutedEventError } from '../errors';
import type { OutboxTx } from '../outbox-port';
import { RecordingIdGenerator, ROUTES, sampleId } from '../testing/messaging-fixtures';
import { DrizzleOutboxWriter } from './drizzle-outbox.writer';

const RECORD = { aggregateType: 'Order', aggregateId: sampleId(100), eventType: 'order.placed', payload: {} };

function build() {
  const values = vi.fn().mockResolvedValue(undefined);
  const tx = { insert: vi.fn(() => ({ values })) } as unknown as OutboxTx;
  const writer = new DrizzleOutboxWriter(new RecordingIdGenerator(), { routes: ROUTES });
  return { writer, tx, values };
}

describe('DrizzleOutboxWriter', () => {
  it('appends a routed event inside the caller transaction', async () => {
    const { writer, tx, values } = build();

    await writer.append(tx, RECORD, { id: sampleId(7) });

    expect(values).toHaveBeenCalledWith(expect.objectContaining({ id: sampleId(7), eventType: 'order.placed' }));
  });

  // Thrown inside the business transaction, so the change it describes rolls back with it.
  it('refuses an event type with no route and writes nothing', async () => {
    const { writer, tx, values } = build();

    await expect(writer.append(tx, { ...RECORD, eventType: 'order.shipped' })).rejects.toBeInstanceOf(
      UnroutedEventError,
    );
    expect(values).not.toHaveBeenCalled();
  });
});
