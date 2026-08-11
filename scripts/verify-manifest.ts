/**
 * Verifies that the answer key tells the truth.
 *
 * The manifest claims that enabling D006 causes a specific test to fail. If the injection
 * is wired up wrongly — a typo'd id, a guard that never fires, a test that stopped
 * covering what it used to — that claim silently becomes false, and every accuracy figure
 * computed against the corpus becomes meaningless while still looking perfectly plausible.
 *
 * So: enable each defect alone, run the suite, and assert the declared test actually
 * failed. This is the test suite for the test suite, and it is the reason you can trust
 * any number this portfolio produces.
 *
 * It is slow — one full suite execution per defect — and belongs in CI on a schedule
 * rather than in the inner development loop.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import manifest from '../contracts/defects.json';

const RUNS_DIR = path.resolve(__dirname, '..', 'artifacts', 'runs');

type Entry = { id: string; layer: string; title: string; reproduceWith?: string };
const M = manifest as unknown as { defects: Entry[] };

function newestRunEvent(since: number): any | null {
  if (!fs.existsSync(RUNS_DIR)) return null;
  const candidates = fs
    .readdirSync(RUNS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ f, mtime: fs.statSync(path.join(RUNS_DIR, f)).mtimeMs }))
    .filter((c) => c.mtime >= since)
    .sort((a, b) => b.mtime - a.mtime);

  const newest = candidates[0];
  return newest ? JSON.parse(fs.readFileSync(path.join(RUNS_DIR, newest.f), 'utf8')) : null;
}

function main() {
  const injectable = M.defects.filter((d) => d.layer !== 'test' && d.layer !== 'infra');
  const problems: string[] = [];

  console.log(`\n  Verifying ${injectable.length} injectable defects.\n`);

  for (const defect of injectable) {
    const startedAt = Date.now();
    process.stdout.write(`  ${defect.id}  ${defect.title.slice(0, 52).padEnd(54)}`);

    // Single command string rather than an args array. Node 24 deprecates combining
    // `shell: true` with separate args (DEP0190) because they are concatenated rather
    // than escaped; there is no user input here, but the warning is noise and the
    // one-string form is equivalent.
    spawnSync('npx playwright test', {
      stdio: 'ignore',
      shell: true,
      env: { ...process.env, DEFECTS: defect.id, FLAKES: 'none', RUN_TRIGGER: 'scheduled' },
    });

    const event = newestRunEvent(startedAt);
    if (!event) {
      problems.push(`${defect.id}: no run event was emitted`);
      console.log('NO EVENT');
      continue;
    }

    const attributed = event.results.filter((r: any) =>
      r.groundTruth?.defectIds?.includes(defect.id)
    );

    if (attributed.length === 0) {
      problems.push(
        `${defect.id}: no test is annotated with this id, so it can never be attributed`
      );
      console.log('UNCOVERED');
      continue;
    }

    const stillPassing = attributed.filter((r: any) => r.status === 'passed' && !r.flaky);

    if (stillPassing.length === attributed.length) {
      problems.push(
        `${defect.id}: enabled, but every test that claims to detect it passed — ` +
          `either the injection does not fire or the test does not assert on it`
      );
      console.log('NOT DETECTED');
      continue;
    }

    console.log(`ok  (${attributed.length - stillPassing.length}/${attributed.length} caught)`);
  }

  if (problems.length > 0) {
    console.error(`\n  ${problems.length} manifest problem(s):\n`);
    for (const problem of problems) console.error(`    - ${problem}`);
    console.error('\n  The answer key does not match reality. Fix this before trusting any');
    console.error('  accuracy figure computed from this corpus.\n');
    process.exit(1);
  }

  console.log('\n  Manifest verified. Every injectable defect is detected by its declared test.\n');
}

main();
