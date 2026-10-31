/**
 * Prints `packages=<JSON array>` to $GITHUB_OUTPUT (stdout when unset): the name of every workspace
 * package with a `test:e2e` script, so CI gives each suite a job without a hand-kept list to forget.
 */
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';

const ROOT = new URL('../', import.meta.url);
const WORKSPACE_DIRS = ['apps', 'packages'];

const names = WORKSPACE_DIRS.flatMap((dir) =>
  readdirSync(new URL(dir, ROOT)).map((name) => new URL(`${dir}/${name}/package.json`, ROOT)),
)
  .filter((file) => existsSync(file))
  .map((file) => JSON.parse(readFileSync(file, 'utf8')))
  .filter((pkg) => pkg.scripts?.['test:e2e'])
  .map((pkg) => pkg.name);

if (names.length === 0) throw new Error('no workspace package defines a test:e2e script');

const line = `packages=${JSON.stringify(names)}\n`;
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, line);
else process.stdout.write(line);
