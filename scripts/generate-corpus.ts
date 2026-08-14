/**
 * Generates a labelled corpus of run events.
 *
 * This is the actual deliverable of Project 0. The application and the test suite exist to
 * produce it: a few hundred runs across known fault configurations, each carrying the
 * correct answer, against which a triage classifier can be scored.
 *
 * Scenario design matters more than volume. A corpus of five hundred identical chaos runs
 * teaches a classifier almost nothing, because every failure co-occurs with every other and
 * nothing can be attributed. Isolated single-defect runs make attribution learnable;
 * combinations then test whether it survives co-occurrence.
 *
 * Structured as a flat list of run specifications rather than scenario-times-repeats,
 * because episodes need the configuration to change from one run to the next within a
 * single logical group.
 */

import { spawnSync } from 'node:child_process';
import manifest from '../contracts/defects.json';

type RunSpec = {
  group: string;
  env: Record<string, string>;
};

const M = manifest as unknown as {
  defects: Array<{ id: string; layer: string }>;
  flakes: Array<{ id: string; defaultProbability: number }>;
};

const injectableDefects = M.defects.filter((d) => d.layer !== 'test').map((d) => d.id);

function spec(group: string, env: Record<string, string>): RunSpec {
  return {
    group,
    env: {
      DEFECTS: 'none',
      FLAKES: 'none',
      FLAKE_SEED: '1337',
      CATALOG_ORDER: 'default',
      CATALOG_EXTRA: '0',
      LOCALE: 'en-US',
      BUTTON_COPY: 'us',
      WRAP_CARDS: '0',
      WORKERS: '1',
      RUN_TRIGGER: 'scheduled',
      ...env,
    },
  };
}

function buildRuns(): RunSpec[] {
  const runs: RunSpec[] = [];

  // Baseline. Should be entirely green; if not, the instrument is broken and nothing
  // downstream is trustworthy.
  for (let i = 0; i < 3; i += 1) {
    runs.push(spec('clean', { FLAKE_SEED: String(1337 + i) }));
  }

  // One defect at a time — the backbone. Unambiguous attribution, because exactly one
  // thing is wrong.
  //
  // D080 is capped at one run: it rejects every request, so a single run labels all 29
  // results `environment` with near-identical cascade evidence. It once produced a third
  // of the entire non-pass corpus from the least informative scenario in the set.
  for (const id of injectableDefects) {
    const repeats = id === 'D080' ? 1 : 2;
    for (let i = 0; i < repeats; i += 1) {
      runs.push(spec(`solo-${id}`, { DEFECTS: id, FLAKE_SEED: String(1337 + i) }));
    }
  }

  // Flakes in isolation across several seeds, so the nondeterminism is genuinely exercised
  // rather than frozen at one arbitrary sequence. F004 gets extra weight: it is the
  // probabilistic environment case, which is what tests whether a classifier has learned
  // that nondeterminism is a property of the symptom while classification depends on where
  // the fault lives.
  for (const flake of M.flakes) {
    const repeats = flake.id === 'F004' ? 3 : 2;
    for (const seed of [11, 22, 33]) {
      for (let i = 0; i < repeats; i += 1) {
        runs.push(
          spec(`flake-${flake.id}`, { FLAKES: flake.id, FLAKE_SEED: String(seed + i) })
        );
      }
    }
  }

  // Test bugs. D052 fires only when its sibling has not run first, which `--grep` produces
  // exactly. D051 needs a legitimate catalog re-sort.
  for (let i = 0; i < 4; i += 1) {
    runs.push(
      spec('isolate-D052', { FLAKE_SEED: String(1337 + i), GREP: 'most recently viewed' })
    );
  }
  for (let i = 0; i < 6; i += 1) {
    runs.push(spec('reorder-D051', { CATALOG_ORDER: 'reverse', FLAKE_SEED: String(1337 + i) }));
  }

  /*
   * D053 and D054 exist because the previous corpus had three test bugs producing ten
   * labels — 2.7% of failures — and an eval split that landed only three of them. A
   * classifier comparison dominated by a three-example class cannot answer whether the
   * model helps: the first hybrid run swung macro F1 by 15 points on that class alone.
   *
   * Both fire under legitimate product configuration, never under defect or flake
   * injection. That is required, not incidental: the reporter's label precedence puts
   * flake attribution above always-on test bugs, so a test bug that only fired under
   * FLAKES would be labelled `flake` and make the corpus worse rather than better.
   */
  for (let i = 0; i < 6; i += 1) {
    runs.push(spec('locale-D053', { LOCALE: 'de-DE', FLAKE_SEED: String(1337 + i) }));
  }
  for (let i = 0; i < 6; i += 1) {
    runs.push(spec('extra-D054-D057', { CATALOG_EXTRA: '1', FLAKE_SEED: String(1337 + i) }));
  }

  /*
   * Brittle-selector scenarios for the locator-healing project.
   *
   * D051 was the only healable case, and one example measures nothing — the same trap that
   * made the first triage comparison meaningless. Four distinct shapes now: positional
   * under reordering (D051), text-dependent (D055), over-specific ancestor chain (D056),
   * and index-based on cardinality (D057).
   *
   * Every lever is legitimate product work — a copy change, a layout refactor, a new
   * product. That is required: if the trigger were a defect, the correct classification
   * would be `product-bug` and the case would not be healable at all.
   */
  for (let i = 0; i < 6; i += 1) {
    runs.push(spec('copy-D055', { BUTTON_COPY: 'uk', FLAKE_SEED: String(1337 + i) }));
  }
  for (let i = 0; i < 6; i += 1) {
    runs.push(spec('wrap-D056', { WRAP_CARDS: '1', FLAKE_SEED: String(1337 + i) }));
  }

  // Worker contention — the only configuration where F003 and D052 are genuinely
  // nondeterministic rather than merely enabled.
  for (const seed of [61, 62, 63]) {
    for (let i = 0; i < 2; i += 1) {
      runs.push(
        spec('parallel-F003', { FLAKES: 'F003', WORKERS: '4', FLAKE_SEED: String(seed + i) })
      );
    }
  }

  /*
   * Episodes.
   *
   * The reason this exists: cross-run failure rate is meaningless without a comparable
   * window. Measured on the previous corpus, the rate feature contributed nothing at all,
   * and the reason was corpus design rather than a bad hypothesis. A defect injected into
   * 2 of 90 scattered runs has a ~2% global failure rate — numerically indistinguishable
   * from a flake — even though it is deterministic and always fires when enabled.
   *
   * Real defects do not behave that way. A bug lands at a commit and then fails every run
   * until someone fixes it. An episode models that: a few clean runs, then the defect
   * switched on and held on, with low-probability flakes throughout so the same window
   * contains both a persistent fault and intermittent noise.
   *
   * Within an episode the affected test fails ~70% of runs while flaky tests fire ~20%.
   * That is a separation a rate feature can actually act on.
   */
  const EPISODE_LENGTH = 10;
  const CLEAN_PREFIX = 3;
  const EPISODE_DEFECTS = ['D001', 'D008', 'D012'];

  for (const defect of EPISODE_DEFECTS) {
    const episodeId = `ep-${defect.toLowerCase()}`;
    for (let index = 0; index < EPISODE_LENGTH; index += 1) {
      const landed = index >= CLEAN_PREFIX;
      runs.push(
        spec(`episode-${defect}`, {
          // Before the "commit", nothing is wrong. After it, the defect persists.
          DEFECTS: landed ? defect : 'none',
          // Flakes run at low probability throughout, in both halves, so the window
          // contains intermittent noise the rate feature has to distinguish from the
          // persistent fault.
          FLAKES: 'F001:0.2,F002:0.2',
          FLAKE_SEED: String(700 + index),
          EPISODE_ID: episodeId,
          EPISODE_INDEX: String(index),
          EPISODE_LENGTH: String(EPISODE_LENGTH),
        })
      );
    }
  }

  // Combinations. Does attribution survive co-occurrence?
  const combos: Array<[string, Record<string, string>]> = [
    ['pair-D004-D008', { DEFECTS: 'D004,D008' }],
    ['confusion-D012', { DEFECTS: 'D012', FLAKES: 'F003', FLAKE_SEED: '44' }],
    ['confusion-D002', { DEFECTS: 'D002', FLAKES: 'F001', FLAKE_SEED: '55' }],
    ['auth-pair', { DEFECTS: 'D010,D081' }],
    ['chaos', { DEFECTS: 'all', FLAKES: 'all', FLAKE_SEED: '99' }],
  ];
  for (const [name, env] of combos) {
    const repeats = name === 'chaos' ? 3 : 2;
    for (let i = 0; i < repeats; i += 1) {
      runs.push(spec(name, { ...env, FLAKE_SEED: String(Number(env.FLAKE_SEED ?? 1337) + i) }));
    }
  }

  return runs;
}

function main() {
  const runs = buildRuns();
  const groups = new Set(runs.map((r) => r.group));

  console.log(`\n  ${runs.length} runs across ${groups.size} groups.\n`);

  runs.forEach((run, i) => {
    const { GREP, ...env } = run.env;
    // Single command string — Node 24 deprecates shell:true combined with an args array.
    const command = GREP ? `npx playwright test --grep "${GREP}"` : 'npx playwright test';

    process.stdout.write(`  [${String(i + 1).padStart(3)}/${runs.length}] ${run.group} … `);

    const result = spawnSync(command, {
      stdio: 'ignore',
      shell: true,
      env: { ...process.env, ...env },
    });

    // A non-zero exit is the expected outcome for most of these — the suite is supposed to
    // fail when defects are injected. What matters is that a run event was written, which
    // the validator checks separately.
    console.log(result.status === 0 ? 'green' : `red (${result.status})`);
  });

  console.log(`\n  Corpus written to artifacts/runs. Validate: npm run validate:events\n`);
}

main();
