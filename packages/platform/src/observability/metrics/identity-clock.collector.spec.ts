import type { FactoryProvider } from '@nestjs/common';
import { register } from 'prom-client';
import { describe, expect, it } from 'vitest';
import { SEQUENCE_COUNT } from '@jcool/id-codec';
import { ClockStalledError, SnowflakeGenerator, type IdentityClock } from '@jcool/id-generator';
import {
  ID_CLOCK_DRIFT_MS,
  ID_CLOCK_STALL_TOTAL,
  IDENTITY_CLOCK_PROVIDERS,
  bindIdentityClockMetrics,
  unbindIdentityClockMetrics,
} from './identity-clock.collector';

// After EPOCH_MS (2026-01-01), the earliest instant the layout can stamp.
const START_MS = 1_800_000_000_000;

// Stepping the wall clock forward is what the generator absorbs as drift; leaving it frozen is
// what makes it refuse to mint.
function fakeClock(): { clock: IdentityClock; stepWall: (ms: number) => void } {
  let wall = START_MS;
  return {
    clock: { wallMs: () => wall, monotonicMs: () => START_MS, elapsedNs: () => 0n },
    stepWall: (ms) => {
      wall += ms;
    },
  };
}

// Through the real factories, so the collect hooks land in the default registry as IdentityModule
// leaves them. willsoto puts its own options token first in `inject`.
for (const provider of IDENTITY_CLOCK_PROVIDERS as FactoryProvider[]) {
  provider.useFactory(undefined);
}

async function scrape(name: string): Promise<number | undefined> {
  const line = (await register.metrics()).split('\n').find((candidate) => candidate.startsWith(`${name} `));
  return line === undefined ? undefined : Number(line.slice(name.length + 1));
}

function stall(generator: SnowflakeGenerator): void {
  // One mint per sequence value at a frozen millisecond; the next one has nowhere left to go.
  for (let i = 0; i < SEQUENCE_COUNT; i++) generator.generate(0);
  expect(() => generator.generate(0)).toThrow(ClockStalledError);
}

describe('identity clock collector', () => {
  // Must stay first: binding is process-wide, so the never-yet-bound state is only reachable here.
  // Absent rather than 0, which on a dashboard is indistinguishable from a healthy clock.
  it('publishes no drift until a generator is bound, then tracks it', async () => {
    await expect(scrape(ID_CLOCK_DRIFT_MS)).resolves.toBeUndefined();

    const fake = fakeClock();
    const generator = SnowflakeGenerator.createWithClock({ nodeId: 0, clock: fake.clock });
    bindIdentityClockMetrics(generator);

    await expect(scrape(ID_CLOCK_DRIFT_MS)).resolves.toBe(0);

    fake.stepWall(40_000);
    generator.generate(0);

    await expect(scrape(ID_CLOCK_DRIFT_MS)).resolves.toBe(40_000);
  });

  it('counts the refusals the generator has answered 503 with', async () => {
    const generator = SnowflakeGenerator.createWithClock({ nodeId: 0, clock: fakeClock().clock });
    bindIdentityClockMetrics(generator);

    await expect(scrape(ID_CLOCK_STALL_TOTAL)).resolves.toBe(0);

    stall(generator);

    await expect(scrape(ID_CLOCK_STALL_TOTAL)).resolves.toBe(1);
  });

  // The registry get-or-creates by name, so a collect hook that captured its generator would stay on
  // the first app built in the process and report a flat 0 as proof the clock is fine.
  it('follows the most recently built generator', async () => {
    const first = fakeClock();
    bindIdentityClockMetrics(SnowflakeGenerator.createWithClock({ nodeId: 0, clock: first.clock }));

    const second = fakeClock();
    const later = SnowflakeGenerator.createWithClock({ nodeId: 0, clock: second.clock });
    bindIdentityClockMetrics(later);

    second.stepWall(1_500);
    later.generate(0);

    await expect(scrape(ID_CLOCK_DRIFT_MS)).resolves.toBe(1_500);
  });

  // A lease swaps its generator whenever it moves to another node. Dropping back to the new one's
  // zero would read as a counter reset to `increase()`, hiding exactly the stalls around the swap.
  it('carries the stall count across a rebind and an unbind', async () => {
    const baseline = (await scrape(ID_CLOCK_STALL_TOTAL)) ?? 0;
    const first = SnowflakeGenerator.createWithClock({ nodeId: 1, clock: fakeClock().clock });
    bindIdentityClockMetrics(first);
    stall(first);

    const second = SnowflakeGenerator.createWithClock({ nodeId: 2, clock: fakeClock().clock });
    bindIdentityClockMetrics(second);
    stall(second);
    await expect(scrape(ID_CLOCK_STALL_TOTAL)).resolves.toBe(baseline + 2);

    unbindIdentityClockMetrics(second);
    await expect(scrape(ID_CLOCK_STALL_TOTAL)).resolves.toBe(baseline + 2);
  });

  // Apps do not close in build order, so an unguarded release lets a shutting-down app blind the
  // metrics for the one still serving.
  it('releases only the generator that is actually bound', async () => {
    const superseded = SnowflakeGenerator.createWithClock({ nodeId: 0, clock: fakeClock().clock });
    bindIdentityClockMetrics(superseded);

    const current = fakeClock();
    const live = SnowflakeGenerator.createWithClock({ nodeId: 0, clock: current.clock });
    bindIdentityClockMetrics(live);
    current.stepWall(700);
    live.generate(0);

    unbindIdentityClockMetrics(superseded);
    await expect(scrape(ID_CLOCK_DRIFT_MS)).resolves.toBe(700);

    unbindIdentityClockMetrics(live);
    await expect(scrape(ID_CLOCK_DRIFT_MS)).resolves.toBeUndefined();
  });
});
