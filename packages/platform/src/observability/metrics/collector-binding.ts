/**
 * What a scrape-time collector reads from. The registry get-or-creates a metric by name, so a collect
 * closure over injected deps would pin the first app built in the process; collectors read through
 * a module-level binding instead, which each app replaces on init and withdraws on destroy.
 */
export interface CollectorBinding<T> {
  bind(source: T): void;
  /** No-op unless `source` is still the bound one, so an older app closing cannot unbind a newer one. */
  unbind(source: T): void;
  current(): T | null;
}

export function createCollectorBinding<T>(): CollectorBinding<T> {
  let bound: T | null = null;
  return {
    bind(source) {
      bound = source;
    },
    unbind(source) {
      if (bound === source) bound = null;
    },
    current: () => bound,
  };
}
