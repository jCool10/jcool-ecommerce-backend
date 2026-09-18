import { AggregateRoot } from './aggregate-root';
import type { DomainEvent } from './domain-event';

class SampleEvent implements DomainEvent {
  readonly eventName = 'sample.happened';
  readonly occurredAt = new Date('2026-01-01T00:00:00.000Z');
  constructor(readonly aggregateId: string) {}
}

class SampleAggregate extends AggregateRoot<string> {
  constructor(id: string) {
    super(id);
  }
  emit(): void {
    this.addDomainEvent(new SampleEvent(this.id));
  }
}

describe('AggregateRoot', () => {
  it('pulls recorded events then clears the buffer', () => {
    const agg = new SampleAggregate('agg-1');
    agg.emit();
    agg.emit();

    const first = agg.pullDomainEvents();
    expect(first).toHaveLength(2);
    expect(first[0].eventName).toBe('sample.happened');
    expect(first[0].aggregateId).toBe('agg-1');

    expect(agg.pullDomainEvents()).toHaveLength(0);
  });

  it('returns a copy so mutating the result does not affect the aggregate', () => {
    const agg = new SampleAggregate('agg-2');
    agg.emit();
    const pulled = agg.pullDomainEvents();
    pulled.push(new SampleEvent('agg-2'));
    expect(agg.pullDomainEvents()).toHaveLength(0);
  });

  it('compares identity by id and type', () => {
    expect(new SampleAggregate('x').equals(new SampleAggregate('x'))).toBe(true);
    expect(new SampleAggregate('x').equals(new SampleAggregate('y'))).toBe(false);
  });
});
