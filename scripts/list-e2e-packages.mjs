/**
 * Prints `packages=<JSON array>` to $GITHUB_OUTPUT (stdout when unset): the name of every workspace
 * package with a `test:e2e` script, so CI gives each suite a job without a hand-kept list to forget.
 */
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';

const ROOT = new URL('../', import.meta.url);
const WORKSPACE_DIRS = ['apps', 'packages'];

const suites = WORKSPACE_DIRS.flatMap((dir) =>
  readdirSync(new URL(dir, ROOT)).map((name) => new URL(`${dir}/${name}/package.json`, ROOT)),
)
  .filter((file) => existsSync(file))
  .map((file) => JSON.parse(readFileSync(file, 'utf8')))
  .filter((pkg) => pkg.scripts?.['test:e2e']);

if (suites.length === 0) throw new Error('no workspace package defines a test:e2e script');

// CI runs `test:e2e:cov`, and turbo runs nothing, green, for a package without the task.
const unpaired = suites.filter((pkg) => !pkg.scripts['test:e2e:cov']).map((pkg) => pkg.name);
if (unpaired.length > 0) throw new Error(`test:e2e without test:e2e:cov in: ${unpaired.join(', ')}`);

const names = suites.map((pkg) => pkg.name);

const line = `packages=${JSON.stringify(names)}\n`;
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, line);
else process.stdout.write(line);
