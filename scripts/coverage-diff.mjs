/**
 * Proof that a test deletion loses no coverage. Compares merged `coverage-final.json` reports:
 *
 *   node scripts/coverage-diff.mjs --before main-1.json --before main-2.json --after pr.json [--allow apps/x/src/gone.ts]
 *
 * Prints every statement and branch arm covered in all --before runs but not in --after, and exits 1
 * when any of them sits outside an --allow path (production code the same PR deletes). Items covered
 * in only some --before runs are listed as unstable and never fail the diff. A test deletion leaves
 * the source untouched, so an equal covered set per file is exact proof.
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    before: { type: 'string', multiple: true },
    after: { type: 'string' },
    allow: { type: 'string', multiple: true, default: [] },
  },
});
if (!values.before?.length || !values.after) {
  console.error(
    'usage: coverage-diff.mjs --before <coverage-final.json>... --after <coverage-final.json> [--allow <src path>]...',
  );
  process.exit(2);
}

function inputError(message) {
  console.error(message);
  process.exit(2);
}

// Absolute paths differ between a laptop and a CI runner; the path from the repo root does not. The
// greedy prefix takes the last `apps/<name>/src` so a checkout under a folder named `apps` still maps.
function repoPath(absolute) {
  const match = /^.*\/((?:apps|packages)\/[^/]+\/src\/.+)$/.exec(absolute.replaceAll('\\', '/'));
  return match ? match[1] : absolute;
}

// The full range, not the start: `a && b ? x : y` opens a ternary and a logical branch on one token.
const range = (loc) => `${loc.start.line}:${loc.start.column}-${loc.end.line}:${loc.end.column}`;

/** Map<file, Set<item>> of the statements and branch arms a report covers. */
function coveredItems(reportPath) {
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  const entries = Object.values(report);
  if (entries.length === 0) inputError(`${reportPath} holds no files`);
  const files = new Map();
  for (const fc of entries) {
    const items = new Set();
    for (const [id, loc] of Object.entries(fc.statementMap)) {
      if (fc.s[id] > 0) items.add(`statement line ${loc.start.line} (${range(loc)})`);
    }
    for (const [id, branch] of Object.entries(fc.branchMap)) {
      const loc = branch.loc ?? branch.locations[0];
      fc.b[id].forEach((hits, arm) => {
        const armLoc = branch.locations?.[arm] ?? loc;
        if (hits > 0) items.add(`${branch.type} arm #${arm} line ${loc.start.line} (${range(loc)} ${range(armLoc)})`);
      });
    }
    files.set(repoPath(fc.path), items);
  }
  return files;
}

const befores = values.before.map(coveredItems);
const after = coveredItems(values.after);

// Runs over different scopes would turn every file the other run lacks into "unstable" and pass.
const scope = [...befores[0].keys()].sort().join('\n');
befores.forEach((run, i) => {
  if ([...run.keys()].sort().join('\n') !== scope) {
    inputError(`--before ${values.before[i]} covers a different file set than ${values.before[0]}`);
  }
});
const allowed = (file) => values.allow.some((p) => file === p || file.startsWith(p.replace(/\/?$/, '/')));
const byLine = (a, b) => Number(/line (\d+)/.exec(a)[1]) - Number(/line (\d+)/.exec(b)[1]);

const dropped = [];
const unstable = [];
for (const file of new Set(befores.flatMap((run) => [...run.keys()]))) {
  const runs = befores.map((run) => run.get(file) ?? new Set());
  const union = new Set(runs.flatMap((items) => [...items]));
  const now = after.get(file) ?? new Set();
  const lost = [];
  const flaky = [];
  for (const item of union) {
    if (!runs.every((items) => items.has(item))) flaky.push(item);
    else if (!now.has(item)) lost.push(item);
  }
  if (lost.length) dropped.push({ file, items: lost.sort(byLine), allowed: allowed(file) });
  if (flaky.length) unstable.push({ file, items: flaky.sort(byLine) });
}

for (const { file, items, allowed: ok } of dropped) {
  console.log(`${file}${ok ? ' (allowed)' : ''}: ${items.length} no longer covered`);
  for (const item of items) console.log(`  ${item}`);
}
if (unstable.length) {
  console.log('unstable (covered in only some --before runs):');
  for (const { file, items } of unstable) console.log(`  ${file}: ${items.join(', ')}`);
}

const failing = dropped.filter((d) => !d.allowed);
if (failing.length) {
  console.log(`coverage dropped in ${failing.length} file(s)`);
  process.exit(1);
}
console.log('no coverage dropped');
