import { describe, expect, it } from 'vitest';
import { type ReadinessCheck, ReadinessCheckRegistry } from './readiness-check.registry';

const check = (name: string): ReadinessCheck => ({ name, check: () => Promise.resolve() });

describe('ReadinessCheckRegistry', () => {
  it('lists the checks in the order they registered', () => {
    const registry = new ReadinessCheckRegistry();
    const temporal = check('temporal');
    const search = check('search');

    registry.register(temporal);
    registry.register(search);

    expect(registry.all()).toEqual([temporal, search]);
  });

  // The name is the key in the readiness body; a silent replace would hide a dependency.
  it('refuses a second check under a name already taken', () => {
    const registry = new ReadinessCheckRegistry();
    registry.register(check('temporal'));

    expect(() => registry.register(check('temporal'))).toThrow(/readiness check "temporal" is already registered/);
    expect(registry.all()).toHaveLength(1);
  });

  it.each(['shutdown', 'database', 'redis'])('refuses the built-in name %s', (name) => {
    expect(() => new ReadinessCheckRegistry().register(check(name))).toThrow(/already registered/);
  });

  it('keeps the checks of each instance separate', () => {
    const first = new ReadinessCheckRegistry();
    first.register(check('temporal'));

    expect(new ReadinessCheckRegistry().all()).toEqual([]);
  });
});
