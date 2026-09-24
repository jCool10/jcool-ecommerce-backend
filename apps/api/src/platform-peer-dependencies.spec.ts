import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

// Platform's dist resolves its peers through its own devDependencies, so a version drift between the
// two manifests loads a second Nest, pino or prom-client and splits DI tokens and metric registries.
const apiRoot = resolve(__dirname, '..');
const platformRoot = realpathSync(join(apiRoot, 'node_modules', '@jcool', 'platform'));
const { peerDependencies } = JSON.parse(readFileSync(join(platformRoot, 'package.json'), 'utf8')) as {
  peerDependencies: Record<string, string>;
};

const fromApi = createRequire(join(apiRoot, 'package.json'));
const fromPlatform = createRequire(join(platformRoot, 'package.json'));

describe('@jcool/platform peer dependencies', () => {
  it('resolves every peer to the install the api loads', () => {
    const split = Object.keys(peerDependencies).filter((name) => fromPlatform.resolve(name) !== fromApi.resolve(name));

    expect(split).toEqual([]);
  });
});
