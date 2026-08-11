/**
 * Fast structural check of the answer key against the code.
 *
 * `verify:manifest` proves the defects genuinely fail their tests, but it costs one full
 * suite execution per defect. This runs in milliseconds, needs no browser and no server,
 * and catches the whole class of drift that is otherwise invisible:
 *
 *   - a manifest entry with no code gating on it (the defect can never fire)
 *   - a defect with no spec annotated against it (it can never be attributed)
 *   - a `defectOn('D0XX')` referencing an id that does not exist (a silent no-op)
 *   - duplicate or malformed ids that would fail schema validation downstream
 *
 * Every one of those keeps the suite green while quietly making the corpus wrong. Cheap
 * enough to run on every commit.
 */

import fs from 'node:fs';
import path from 'node:path';

import manifest from '../contracts/defects.json';

const ROOT = path.resolve(__dirname, '..');

type Entry = {
  id: string;
  classification: string;
  layer?: string;
  mechanism?: string;
};

const M = manifest as unknown as { defects: Entry[]; flakes: Entry[] };

const VALID_CLASSIFICATIONS = ['product-bug', 'test-bug', 'environment', 'flake'];

/**
 * D080 fails every request indiscriminately, so no single spec "owns" it. Exempt from the
 * annotation-coverage rule rather than bolting a meaningless annotation onto an arbitrary
 * test just to satisfy the check.
 */
const ANNOTATION_EXEMPT = new Set(['D080']);

function walk(dir: string, acc: string[] = []): string[] {
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) return acc;
  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(rel, acc);
    else if (/\.(ts|js)$/.test(entry.name)) acc.push(rel);
  }
  return acc;
}

function main() {
  const problems: string[] = [];

  const defectIds = M.defects.map((d) => d.id);
  const flakeIds = M.flakes.map((f) => f.id);
  const allIds = [...defectIds, ...flakeIds];

  /* -- id hygiene -------------------------------------------------------- */

  const seen = new Set<string>();
  for (const id of allIds) {
    if (seen.has(id)) problems.push(`duplicate manifest id: ${id}`);
    seen.add(id);
  }

  for (const id of defectIds) {
    if (!/^D\d{3}$/.test(id)) problems.push(`defect id violates schema pattern ^D\\d{3}$: ${id}`);
  }
  for (const id of flakeIds) {
    if (!/^F\d{3}$/.test(id)) problems.push(`flake id violates schema pattern ^F\\d{3}$: ${id}`);
  }

  for (const entry of [...M.defects, ...M.flakes]) {
    if (!VALID_CLASSIFICATIONS.includes(entry.classification)) {
      problems.push(`${entry.id}: unknown classification "${entry.classification}"`);
    }
  }

  /* -- what the code actually gates on ----------------------------------- */

  const sourceFiles = [...walk('src'), ...walk('reporters')];
  const specFiles = walk('tests');

  const gated = new Set<string>();
  for (const file of sourceFiles) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const re = /(?:defectOn|flakeFires|flakeEnabled)\(['"]([DF]\d{3})['"]\)/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text))) gated.add(match[1]!);
  }

  const annotated = new Set<string>();
  for (const file of specFiles) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const re = /targets\(([^)]*)\)/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text))) {
      for (const id of match[1]!.match(/[DF]\d{3}/g) ?? []) annotated.add(id);
    }
  }

  for (const id of gated) {
    if (!allIds.includes(id)) problems.push(`code gates on unknown id ${id} — a silent no-op`);
  }
  for (const id of annotated) {
    if (!allIds.includes(id)) problems.push(`spec annotation references unknown id: ${id}`);
  }

  /* -- coverage ---------------------------------------------------------- */

  for (const defect of M.defects) {
    // Test bugs live in the spec files themselves and are never gated in application code.
    if (defect.layer !== 'test' && !gated.has(defect.id)) {
      problems.push(`${defect.id} is in the manifest but no application code gates on it`);
    }
    if (!ANNOTATION_EXEMPT.has(defect.id) && !annotated.has(defect.id)) {
      problems.push(`${defect.id} has no spec annotated with targets() — it can never be attributed`);
    }
  }

  for (const flake of M.flakes) {
    if (!gated.has(flake.id)) {
      problems.push(`${flake.id} is in the manifest but no application code gates on it`);
    }
  }

  /* -- report ------------------------------------------------------------ */

  console.log(
    `\n  ${defectIds.length} defects, ${flakeIds.length} flakes · ` +
      `${gated.size} gated in code · ${annotated.size} annotated in specs\n`
  );

  if (problems.length > 0) {
    console.error(`  ${problems.length} consistency problem(s):\n`);
    for (const problem of problems) console.error(`    x ${problem}`);
    console.error('');
    process.exit(1);
  }

  console.log('  Manifest, application code and specs are consistent.\n');
}

main();
