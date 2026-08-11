/**
 * Generates a labelled corpus of run events.
 *
 * This is the actual deliverable of Project 0. The application and the test suite exist
 * to produce this: a few hundred runs across known fault configurations, each carrying
 * the correct answer, against which a triage classifier can be scored.
 *
 * Scenario design matters more than volume. A corpus of five hundred identical chaos runs
 * teaches a classifier almost nothing, because every failure co-occurs with every other
 * and it cannot learn which evidence attaches to which cause. Isolated single-defect runs
 * are what make attribution learnable; combinations then test whether it holds up when
 * several causes are present at once.
 */

import { spawnSync } from 'node:child_process';
import manifest from '../contracts/defects.json';

type Scenario = {
  name: string;
  defects: string;
  flakes: string;
  seed: number;
  repeats: number;
  extraEnv?: Record<string, string>;
  /** Extra Playwright CLI arguments, e.g. `--grep` for isolation runs. */
  args?: string;
};

const M = manifest as unknown as {
  defects: Array<{ id: string; layer: string }>;
  flakes: Array<{ id: string }>;
};

const injectableDefects = M.defects.filter((d) => d.layer !== 'test').map((d) => d.id);

function buildScenarios(): Scenario[] {
  const scenarios: Scenario[] = [
    // Baseline. Everything here should be green apart from the always-on test bugs, and
    // if it is not, the proving ground itself is broken and nothing downstream is
    // trustworthy. Run it first and run it often.
    { name: 'clean', defects: 'none', flakes: 'none', seed: 1337, repeats: 3 },
  ];

  // One defect at a time. The backbone of the corpus: unambiguous attribution, because
  // exactly one thing is wrong.
  //
  // D080 is capped at a single repeat. It rejects every request, so one run labels all 29
  // results `environment` with near-identical cascade evidence. In corpus v1 it alone
  // produced 160 of the 236 environment labels — a third of the entire non-pass corpus,
  // from the least informative scenario in the set. Volume is not the same as signal.
  for (const id of injectableDefects) {
    scenarios.push({
      name: `solo-${id}`,
      defects: id,
      flakes: 'none',
      seed: 1337,
      repeats: id === 'D080' ? 1 : 2,
    });
  }

  // Flakes in isolation, across several seeds so the nondeterminism is actually exercised
  // rather than frozen at one arbitrary sequence.
  //
  // F004 gets extra repeats: it is the probabilistic environment case, the one that tests
  // whether a classifier has learned that nondeterminism is a property of the *symptom*
  // while classification depends on where the fault lives. In v1 it produced only 12
  // labels against D080's 160, which is precisely backwards.
  for (const flake of M.flakes) {
    for (const seed of [11, 22, 33]) {
      scenarios.push({
        name: `flake-${flake.id}-s${seed}`,
        defects: 'none',
        flakes: flake.id,
        seed,
        repeats: flake.id === 'F004' ? 4 : 2,
      });
    }
  }

  /*
   * Test-bug scenarios.
   *
   * v1 produced 8 test-bug labels out of 491 non-pass results — 1.6%, and D052 produced
   * none at all, because the corpus never ran a test in isolation or changed catalog
   * order often enough. That left the D012-vs-D052 confusion pair, the sharpest
   * discrimination task in the manifest, with nothing on one side of it.
   *
   * These scenarios exist to fix that. They are cheap: an isolation run executes a single
   * test.
   */

  // D052 fires when its sibling has not run first. `--grep` gives exactly that condition:
  // the spec asserts on recently-viewed state that nothing established.
  for (const seed of [1337, 1338, 1339, 1340]) {
    scenarios.push({
      name: 'isolate-D052',
      defects: 'none',
      flakes: 'none',
      seed,
      repeats: 1,
      args: '--grep "most recently viewed"',
    });
  }

  // D051 under a legitimate catalog re-sort. Raised from 2 repeats to 6.
  scenarios.push({
    name: 'reorder-D051',
    defects: 'none',
    flakes: 'none',
    seed: 1337,
    repeats: 6,
    extraEnv: { CATALOG_ORDER: 'reverse' },
  });

  // Worker contention. The only configuration in which F003 and D052 are genuinely
  // nondeterministic rather than merely enabled — the global reset hook and the shared
  // recently-viewed list contend across workers.
  for (const seed of [61, 62, 63]) {
    scenarios.push({
      name: 'parallel-F003',
      defects: 'none',
      flakes: 'F003',
      seed,
      repeats: 2,
      extraEnv: { WORKERS: '4' },
    });
  }

  // Combinations. Tests whether attribution survives co-occurrence.
  scenarios.push(
    { name: 'pair-D004-D008', defects: 'D004,D008', flakes: 'none', seed: 1337, repeats: 2 },
    { name: 'confusion-D012', defects: 'D012', flakes: 'F003', seed: 44, repeats: 3 },
    { name: 'confusion-D002', defects: 'D002', flakes: 'F001', seed: 55, repeats: 3 },
    { name: 'auth-pair', defects: 'D010,D081', flakes: 'none', seed: 1337, repeats: 2 },
    { name: 'infra', defects: 'D080', flakes: 'none', seed: 1337, repeats: 1 },
    { name: 'chaos', defects: 'all', flakes: 'all', seed: 99, repeats: 3 }
  );

  return scenarios;
}

function main() {
  const scenarios = buildScenarios();
  const totalRuns = scenarios.reduce((sum, s) => sum + s.repeats, 0);

  console.log(`\n  ${scenarios.length} scenarios, ${totalRuns} runs total.\n`);

  let completed = 0;

  for (const scenario of scenarios) {
    for (let i = 0; i < scenario.repeats; i += 1) {
      completed += 1;
      process.stdout.write(
        `  [${String(completed).padStart(3)}/${totalRuns}] ${scenario.name} … `
      );

      // Single command string — see the DEP0190 note in verify-manifest.ts.
      const command = scenario.args
        ? `npx playwright test ${scenario.args}`
        : 'npx playwright test';

      const result = spawnSync(command, {
        stdio: 'ignore',
        shell: true,
        env: {
          ...process.env,
          DEFECTS: scenario.defects,
          FLAKES: scenario.flakes,
          // Vary the seed per repeat so repeats are not carbon copies of one another.
          FLAKE_SEED: String(scenario.seed + i),
          RUN_TRIGGER: 'scheduled',
          CATALOG_ORDER: 'default',
          WORKERS: '1',
          ...scenario.extraEnv,
        },
      });

      // A non-zero exit code is the expected outcome for most scenarios — the suite is
      // supposed to fail when defects are injected. What matters is that a run event was
      // written, which the validator checks separately.
      console.log(result.status === 0 ? 'green' : `red (exit ${result.status})`);
    }
  }

  console.log(`\n  Corpus written to artifacts/runs. Validate it with: npm run validate:events\n`);
}

main();
