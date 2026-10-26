import { describe, expect, it } from 'vitest';
import { createCollectorBinding } from './collector-binding';

describe('createCollectorBinding', () => {
  it('starts unbound', () => {
    expect(createCollectorBinding<string>().current()).toBeNull();
  });

  it('serves the latest bind', () => {
    const binding = createCollectorBinding<{ app: string }>();
    const first = { app: 'first' };
    const second = { app: 'second' };

    binding.bind(first);
    binding.bind(second);

    expect(binding.current()).toBe(second);
  });

  it('leaves a newer bind in place when an older source unbinds', () => {
    const binding = createCollectorBinding<{ app: string }>();
    const older = { app: 'older' };
    const newer = { app: 'newer' };
    binding.bind(older);
    binding.bind(newer);

    binding.unbind(older);

    expect(binding.current()).toBe(newer);
  });

  it('clears when the bound source unbinds', () => {
    const binding = createCollectorBinding<{ app: string }>();
    const source = { app: 'only' };
    binding.bind(source);

    binding.unbind(source);

    expect(binding.current()).toBeNull();
  });
});
