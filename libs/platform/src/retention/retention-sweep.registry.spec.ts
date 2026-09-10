import { describe, expect, it, vi } from 'vitest';
import type { RetentionSweep } from './retention-sweep.port';
import { RetentionSweepRegistry } from './retention-sweep.registry';

const sweep = (name: string): RetentionSweep => ({ name, sweep: vi.fn().mockResolvedValue(0) });

describe('RetentionSweepRegistry', () => {
  it('hands the scheduler every sweep that registered', () => {
    const registry = new RetentionSweepRegistry();
    const outbox = sweep('messaging:outbox');
    const inbox = sweep('messaging:inbox');

    registry.register(outbox);
    registry.register(inbox);

    expect(registry.all()).toEqual([outbox, inbox]);
    expect(registry.names()).toEqual(['messaging:outbox', 'messaging:inbox']);
  });

  it('starts empty, so an app that registered nothing sweeps nothing', () => {
    expect(new RetentionSweepRegistry().all()).toEqual([]);
  });

  // The name is the metric label; a silent replace would leave a table unreclaimed.
  it('rejects a second sweep under a name already taken', () => {
    const registry = new RetentionSweepRegistry();
    registry.register(sweep('messaging:outbox'));

    expect(() => registry.register(sweep('messaging:outbox'))).toThrow(/Duplicate retention sweep name/);
    expect(registry.all()).toHaveLength(1);
  });

  // Nest can call onModuleInit more than once when a module appears in several graphs.
  it('accepts the same instance registering itself twice', () => {
    const registry = new RetentionSweepRegistry();
    const outbox = sweep('messaging:outbox');

    registry.register(outbox);

    expect(() => registry.register(outbox)).not.toThrow();
    expect(registry.all()).toEqual([outbox]);
  });

  it('keeps each instance separate, so one app never inherits the sweeps of another', () => {
    const first = new RetentionSweepRegistry();
    const second = new RetentionSweepRegistry();

    first.register(sweep('messaging:outbox'));

    expect(second.all()).toEqual([]);
  });
});
