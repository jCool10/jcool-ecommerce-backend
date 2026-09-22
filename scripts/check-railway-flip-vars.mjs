/**
 * A service owns its variables: a name missing from .railway/railway.ts is deleted on the next
 * apply, and one written as a literal there overrides whatever an operator set. Either would revert
 * a switch that was flipped by hand mid-cutover, hours later and without a deploy of its own. These
 * names must therefore stay declared, and stay preserve()d.
 */
import { readFileSync } from 'node:fs';

const SOURCE_PATH = new URL('../.railway/railway.ts', import.meta.url);
const source = readFileSync(SOURCE_PATH, 'utf8');

const REQUIRED = {
  'service(API_SERVICE': ['TRUST_PROXY'],
  "service('gateway'": ['AUTH_UPSTREAM', 'AUTH_UPSTREAM_REQUIRED', 'AUTH_WRITE_FREEZE', 'TRUSTED_PROXY_CIDRS'],
};

function blockAfter(marker) {
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`${marker} is gone from .railway/railway.ts`);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces after ${marker}`);
}

const namesIn = (text) => [...text.matchAll(/'([A-Z][A-Z0-9_]*)'/g)].map(([, name]) => name);

function arrayNamed(identifier) {
  const declaration = new RegExp(`const ${identifier} = \\[([^\\]]*)\\]`).exec(source);
  if (!declaration) throw new Error(`${identifier} is not an array literal in .railway/railway.ts`);
  return declaration[1];
}

function preservedIn(block) {
  return [...block.matchAll(/preserved\(([^)]*)\)/g)].flatMap(([, argument]) => {
    const trimmed = argument.trim();
    return namesIn(trimmed.startsWith('[') ? trimmed : arrayNamed(trimmed));
  });
}

let failed = false;
for (const [marker, required] of Object.entries(REQUIRED)) {
  const block = blockAfter(marker);
  const preserved = new Set(preservedIn(block));
  const literals = new Set([...block.matchAll(/^\s+([A-Z][A-Z0-9_]*):/gm)].map(([, name]) => name));

  for (const name of required) {
    if (!preserved.has(name)) {
      console.error(`${marker}…): ${name} is not preserve()d — an apply would delete it.`);
      failed = true;
    } else if (literals.has(name)) {
      console.error(`${marker}…): ${name} is written as a literal — an apply would overwrite it.`);
      failed = true;
    }
  }
}

if (failed) process.exit(1);
console.log('Railway flip variables are declared and preserved.');
