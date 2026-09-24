import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// In the workspace platform's dist resolves its peers through its own devDependencies; a drift from
// this service's copies would load a second Nest, pino or prom-client and split DI tokens and metric
// registries. Only the peers this service installs: the rest belong to subpaths it never loads.
const serviceRoot = resolve(__dirname, '..');
const platformRoot = realpathSync(join(serviceRoot, 'node_modules', '@jcool', 'platform'));
const readManifest = (root: string) =>
  JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };

const installed = new Set(Object.keys(readManifest(serviceRoot).dependencies ?? {}));
const sharedPeers = Object.keys(readManifest(platformRoot).peerDependencies ?? {}).filter((name) =>
  installed.has(name),
);

const fromService = createRequire(join(serviceRoot, 'package.json'));
const fromPlatform = createRequire(join(platformRoot, 'package.json'));

describe('@jcool/platform peer dependencies', () => {
  it('resolve to the installs id-service loads', () => {
    const drifted = sharedPeers.filter((name) => fromPlatform.resolve(name) !== fromService.resolve(name));

    expect(sharedPeers.length).toBeGreaterThan(0);
    expect(drifted).toEqual([]);
  });
});
