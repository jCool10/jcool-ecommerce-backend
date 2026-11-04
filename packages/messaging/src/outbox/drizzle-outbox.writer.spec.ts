import { UnroutedEventError } from '../errors';
import type { OutboxTx } from '../outbox-port';
import { RecordingIdGenerator, ROUTES, sampleId } from '../testing/messaging-fixtures';
import { DrizzleOutboxWriter } from './drizzle-outbox.writer';

const RECORD = { aggregateType: 'Order', aggregateId: sampleId(100), eventType: 'order.placed', payload: {} };

function build() {
  const values = vi.fn().mockResolvedValue(undefined);
  const tx = { insert: vi.fn(() => ({ values })) } as unknown as OutboxTx;
  const ids = new RecordingIdGenerator();
  const mint = vi.spyOn(ids, 'mint');
  const writer = new DrizzleOutboxWriter(ids, { routes: ROUTES });
  return { writer, tx, values, mint };
}

describe('DrizzleOutboxWriter', () => {
  it('appends a routed event inside the caller transaction', async () => {
    const { writer, tx, values } = build();

    await writer.append(tx, RECORD, { id: sampleId(7) });

    expect(values).toHaveBeenCalledWith(expect.objectContaining({ id: sampleId(7), eventType: 'order.placed' }));
  });

  it('stores the id the minter hands out when the caller brings none', async () => {
    const { writer, tx, values, mint } = build();

    await writer.append(tx, RECORD);

    expect(mint).toHaveBeenCalledOnce();
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ id: sampleId(0) }));
  });

  // Thrown inside the business transaction, so the change it describes rolls back with it.
  it('refuses an event type with no route and writes nothing', async () => {
    const { writer, tx, values } = build();

    await expect(writer.append(tx, { ...RECORD, eventType: 'order.shipped' })).rejects.toBeInstanceOf(
      UnroutedEventError,
    );
    expect(values).not.toHaveBeenCalled();
  });

  it('refuses an unrouted event before asking the minter for an id', async () => {
    const { writer, tx, mint } = build();

    await expect(writer.append(tx, { ...RECORD, eventType: 'order.shipped' })).rejects.toBeInstanceOf(
      UnroutedEventError,
    );
    expect(mint).not.toHaveBeenCalled();
  });
});
