import type { DynamicModule, Type } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtAuthGuard } from '@jcool/auth-verifier';
import { RolesGuard } from '@jcool/platform/rbac';
import { AccountAwareThrottlerGuard } from '@jcool/platform/throttler';
import { AppModule } from './app.module';

type ImportEntry = Type | DynamicModule | Promise<DynamicModule> | { forwardRef: () => Type };

interface ProviderEntry {
  provide?: unknown;
  useClass?: Type;
}

const isDynamic = (entry: Type | DynamicModule): entry is DynamicModule => 'module' in entry;

/**
 * Global guards run in the order their modules were scanned: depth-first from the root, the root's
 * own providers first, each module once. Replaying that walk over the decorators shows the order
 * the app will run them in, without booting it.
 */
async function globalGuardsInScanOrder(root: Type): Promise<Type[]> {
  const guards: Type[] = [];
  const seen = new Set<Type>();

  async function visit(raw: ImportEntry): Promise<void> {
    const entry = 'forwardRef' in raw ? raw.forwardRef() : await raw;
    const type = isDynamic(entry) ? entry.module : entry;
    if (seen.has(type)) return;
    seen.add(type);

    const providers = [
      ...((Reflect.getMetadata('providers', type) as ProviderEntry[] | undefined) ?? []),
      ...(isDynamic(entry) ? ((entry.providers ?? []) as ProviderEntry[]) : []),
    ];
    for (const provider of providers) {
      if (provider.provide === APP_GUARD && provider.useClass) guards.push(provider.useClass);
    }

    const imports = [
      ...((Reflect.getMetadata('imports', type) as ImportEntry[] | undefined) ?? []),
      ...(isDynamic(entry) ? ((entry.imports ?? []) as ImportEntry[]) : []),
    ];
    for (const child of imports) await visit(child);
  }

  await visit(root);
  return guards;
}

describe('AppModule global guards', () => {
  // A flood of bad bearers is shed at the throttler's 429 before any of it costs a signature check.
  it('throttles, then authenticates, then authorizes', async () => {
    await expect(globalGuardsInScanOrder(AppModule)).resolves.toEqual([
      AccountAwareThrottlerGuard,
      JwtAuthGuard,
      RolesGuard,
    ]);
  });
});
