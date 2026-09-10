import { fileURLToPath } from 'node:url';

// The fourth copy of the alias table (tsconfig.json → typecheck, .swcrc → the emitted build, here →
// both Vitest tiers). Kept in one module so the unit and e2e configs cannot drift from each other;
// they still have to be kept in step with the two above by hand.
//
// Vite resolves `alias` by longest-prefix string replacement, so one entry per family covers both
// the bare and the deep import (`@shared/kernel` and `@shared/kernel/money.vo`). No family here is a
// prefix of another, so ordering carries no meaning.
const families: Record<string, string> = {
  '@modules': 'apps/commerce-core/src/modules',
  '@commerce-core': 'apps/commerce-core/src',

  '@shared/kernel': 'libs/kernel/src',
  '@shared/rbac': 'libs/rbac/src',
  '@shared/config': 'libs/config/src',
  '@shared/identity': 'libs/identity/src',
  '@shared/mail': 'libs/mail/src',
  '@shared/messaging': 'libs/messaging/src',
  '@shared/observability': 'libs/observability/src',
  '@shared/resilience': 'libs/resilience/src',
  '@shared/cache': 'libs/redis/src/cache',
  '@shared/health': 'libs/platform/src/health',
  '@shared/idempotency': 'libs/platform/src/idempotency',
  '@shared/interface': 'libs/platform/src/interface',
  '@shared/retention': 'libs/platform/src/retention',
  '@shared/infrastructure/database': 'libs/db/src',
  '@shared/infrastructure/redis': 'libs/redis/src',
  '@shared/infrastructure/storage': 'libs/storage/src',
  '@shared/infrastructure/throttler': 'libs/platform/src/throttler',
};

/** Absolute-path alias map for a Vitest config living at `repoRoot`. */
export function workspaceAliases(repoRootUrl: URL): Record<string, string> {
  return Object.fromEntries(
    Object.entries(families).map(([alias, target]) => [alias, fileURLToPath(new URL(target, repoRootUrl))]),
  );
}
