/**
 * Run-event reporter — the contract producer.
 *
 * Translates Playwright's internal result model into the shared run-event schema. Every
 * consumer in the portfolio reads this output and none of them ever import Playwright,
 * which is the whole point: the harness is replaceable, the contract is not.
 */

import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import type {
  Reporter,
  FullConfig,
  Suite,
  TestCase,
  TestResult,
  FullResult,
  TestError,
} from '@playwright/test/reporter';

import manifest from '../contracts/defects.json';

/**
 * Contract version emitted with every run.
 *
 * 1.1.0 relaxed `error.signature` normalisation. The JSON Schema is byte-identical to
 * 1.0.0 — the shape did not move — but every downstream clustering result changes, so it
 * is a version bump. Version the observable behaviour of the data, not the file that
 * describes its shape.
 *
 * 1.2.0 added the optional `episode` block. A new optional field is a textbook minor:
 * consumers written against 1.1.0 ignore what they do not recognise and keep working.
 */
const SCHEMA_VERSION = '1.2.0';

type ManifestEntry = { id: string; classification: string; layer?: string };
const MANIFEST = manifest as unknown as {
  defects: ManifestEntry[];
  flakes: ManifestEntry[];
};

const ENTRY_BY_ID = new Map<string, ManifestEntry>(
  [...MANIFEST.defects, ...MANIFEST.flakes].map((e) => [e.id, e])
);

/* -------------------------------------------------------------------------- */
/* Normalisation helpers                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Playwright embeds ANSI colour codes in error messages. Left in place they corrupt every
 * downstream operation: clustering keys differ by terminal capability, embeddings burn
 * tokens on escape sequences, and diffing two identical errors shows spurious changes.
 * Stripping them here — once, at the boundary — is far cheaper than every consumer having
 * to know about it.
 */
// eslint-disable-next-line no-control-regex
const ANSI = /\[[0-9;]*m/g;

function clean(value: string | undefined): string {
  return (value ?? '').replace(ANSI, '').trim();
}

/**
 * Reduces an error message to its root-cause shape by replacing run-varying tokens —
 * uuids, timestamps, paths, urls, durations — with placeholders.
 *
 * Two failures with the same cause collapse to the same signature, so you cluster
 * deterministically and only spend model tokens on one representative per cluster.
 *
 * Deliberately NOT normalised: plain numbers and quoted literals.
 *
 * An earlier version replaced every number with <num> and every quoted string with <str>.
 * Measured against a 101-run corpus, that collapsed 491 failures into 13 clusters of which
 * only 5 were pure — a 7.7% ceiling for signature-only classification — because
 * "expected 401, got 200" (an auth defect) and "expected 18, got 16.20" (a discount
 * defect) produced identical keys.
 *
 * Asserted values and locator strings are the most discriminating evidence available.
 * Normalising them away optimises for a small cluster count, which is not the goal. The
 * goal is clusters whose members share a root cause.
 */
function signatureOf(message: string): string {
  return clean(message)
    .split('\n')
    .slice(0, 3)
    .join(' ')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, '<timestamp>')
    .replace(/(?:[A-Za-z]:)?[\\/][\w.\-\\/]+\.(?:ts|js|tsx|jsx)(?::\d+:\d+)?/g, '<path>')
    .replace(/https?:\/\/[^\s)'"]+/g, '<url>')
    .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
    .replace(/\b\d+(?:\.\d+)?\s*ms\b/g, '<duration>')
    // Server-generated ids: line-0001, order-0002, CN-000001. Vary per run, carry no
    // diagnostic weight.
    .replace(/\b(?:line|order)-\d+\b/g, '<id>')
    .replace(/\bCN-\d+\b/g, '<confirmation>')
    .replace(/\s+/g, ' ')
    .slice(0, 400)
    .trim();
}

function posixRelative(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join('/');
}

/**
 * Stable across runs, and deliberately excludes line numbers.
 *
 * Downstream history correlation — "what is this test's flake rate over ninety days" —
 * breaks the moment a test's identity changes for a reason unrelated to the test. Adding
 * a line above it must not create a new test in the eyes of the corpus.
 */
function stableTestId(relativeFile: string, titlePath: string[]): string {
  return createHash('sha256')
    .update(`${relativeFile}::${titlePath.join(' > ')}`)
    .digest('hex')
    .slice(0, 16);
}

function extractLocator(message: string): string | undefined {
  const match =
    message.match(/waiting for (?:locator|element)\s*\(?['"`](.+?)['"`]\)?/i) ??
    message.match(/locator\(['"`](.+?)['"`]\)/) ??
    message.match(/getByTestId\(['"`](.+?)['"`]\)/);
  return match?.[1];
}

function extractExpectedActual(message: string): { expected?: string; actual?: string } {
  const expected = message.match(/Expected(?: pattern| string| value)?:\s*(.+)/)?.[1];
  const actual = message.match(/(?:Received(?: string| value)?|Actual):\s*(.+)/)?.[1];
  return { expected: expected?.trim(), actual: actual?.trim() };
}

/**
 * Groups this run into an ordered sequence sharing a code state.
 *
 * Exists because cross-run failure rate is meaningless without a comparable window. A
 * defect injected in 2 of 90 scattered runs has a 2% global failure rate — numerically
 * identical to a flake — even though within its own episode it fails every time. Real
 * systems get this window for free from the git sha or deployment id; here it comes from
 * the corpus generator.
 */
function episodeFromEnv() {
  const id = process.env.EPISODE_ID;
  if (!id) return undefined;

  const index = Number(process.env.EPISODE_INDEX ?? 0);
  const length = Number(process.env.EPISODE_LENGTH ?? 1);
  if (!Number.isInteger(index) || !Number.isInteger(length) || length < 1 || index < 0) {
    return undefined;
  }
  return { id, index, length };
}

function gitInfo() {
  const run = (cmd: string) => execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  try {
    return {
      sha: run('git rev-parse HEAD'),
      branch: run('git rev-parse --abbrev-ref HEAD'),
      dirty: run('git status --porcelain').length > 0,
    };
  } catch {
    // Not a git repository, or git is unavailable. The field is optional in the schema
    // precisely so this case does not have to be faked.
    return undefined;
  }
}

/* -------------------------------------------------------------------------- */
/* Reporter                                                                    */
/* -------------------------------------------------------------------------- */

type Injection = { defects: string[]; flakes: Record<string, number>; seed: number };

export default class RunEventReporter implements Reporter {
  private readonly outputDir: string;
  private config!: FullConfig;
  private suite!: Suite;
  private startedAt = new Date();
  private results = new Map<string, TestResult[]>();
  private injectionPromise: Promise<Injection> = Promise.resolve({
    defects: [],
    flakes: {},
    seed: 0,
  });

  constructor(options: { outputDir?: string } = {}) {
    this.outputDir = options.outputDir ?? './artifacts/runs';
  }

  onBegin(config: FullConfig, suite: Suite) {
    this.config = config;
    this.suite = suite;
    this.startedAt = new Date();

    const baseURL =
      (config.projects[0]?.use as { baseURL?: string } | undefined)?.baseURL ??
      'http://localhost:3100';

    /**
     * Ask the *server* what faults it has enabled, rather than reading this process's own
     * environment.
     *
     * The runner and the server are separate processes and can drift apart — a stale
     * server left running from a previous `npm run dev`, a CI step that sets the variable
     * for one and not the other. Trusting local env would label the corpus with faults the
     * application never had, and the error would stay invisible until scoring.
     */
    this.injectionPromise = fetch(`${baseURL}/api/_meta/injection`)
      .then((r) => r.json() as Promise<Injection>)
      .catch(() => ({ defects: [], flakes: {}, seed: -1 }));
  }

  onTestEnd(test: TestCase, result: TestResult) {
    const existing = this.results.get(test.id) ?? [];
    existing.push(result);
    this.results.set(test.id, existing);
  }

  async onEnd(fullResult: FullResult) {
    const finishedAt = new Date();
    const injection = await this.injectionPromise;
    const root = this.config.rootDir;

    const results = this.suite.allTests().map((test) => this.toResult(test, root, injection));

    const totals = {
      total: results.length,
      passed: results.filter((r) => r.status === 'passed' && !r.flaky).length,
      failed: results.filter((r) => r.status === 'failed').length,
      flaky: results.filter((r) => r.flaky).length,
      skipped: results.filter((r) => r.status === 'skipped').length,
      timedOut: results.filter((r) => r.status === 'timedOut').length,
    };

    const runId = `run-${finishedAt.toISOString().replace(/[:.]/g, '-')}-${createHash('sha1')
      .update(String(Math.random()))
      .digest('hex')
      .slice(0, 6)}`;

    const event = {
      schemaVersion: SCHEMA_VERSION,
      runId,
      startedAt: this.startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - this.startedAt.getTime(),
      trigger: process.env.CI ? 'ci' : ((process.env.RUN_TRIGGER as string) ?? 'local'),
      git: gitInfo(),
      episode: episodeFromEnv(),
      environment: {
        os: `${os.platform()}-${os.release()}`,
        nodeVersion: process.version,
        runnerVersion: this.config.version,
        baseUrl:
          (this.config.projects[0]?.use as { baseURL?: string } | undefined)?.baseURL ?? '',
        ci: Boolean(process.env.CI),
        workers: this.config.workers,
      },
      injection,
      totals,
      results,
    };

    // Strip undefined so the payload matches the schema's additionalProperties rules
    // rather than carrying explicit nulls the consumers would have to special-case.
    const serialised = JSON.stringify(event, (_key, value) => (value === undefined ? undefined : value), 2);

    fs.mkdirSync(this.outputDir, { recursive: true });
    const outputPath = path.join(this.outputDir, `${runId}.json`);
    fs.writeFileSync(outputPath, serialised, 'utf8');

    const labelled = results.filter((r) => r.groundTruth).length;
    console.log(`\n  run event → ${outputPath}`);
    console.log(
      `  ${totals.total} tests · ${totals.failed} failed · ${totals.flaky} flaky · ` +
        `${labelled}/${totals.total} labelled\n`
    );
    void fullResult;
  }

  /* ------------------------------------------------------------------------ */

  private toResult(test: TestCase, root: string, injection: Injection) {
    const attempts = this.results.get(test.id) ?? [];
    const last = attempts[attempts.length - 1];
    const relativeFile = posixRelative(root, test.location.file);

    const outcome = test.outcome();
    const status = this.statusOf(outcome, last);
    const flaky = outcome === 'flaky';

    // The most informative attempt is the failing one, not the final one. On a flaky test
    // the last attempt passed and carries no error, so the evidence a consumer needs lives
    // in an earlier attempt.
    const errorSource = attempts.find((a) => a.error) ?? last;
    const error = errorSource?.error ? this.toError(errorSource.error) : null;

    const declaredDefects = test.annotations
      .filter((a) => a.type === 'defect')
      .map((a) => a.description ?? '')
      .filter(Boolean);

    return {
      testId: stableTestId(relativeFile, test.titlePath().filter(Boolean).slice(1)),
      title: test.title,
      titlePath: test.titlePath().filter(Boolean).slice(1, -1),
      file: relativeFile,
      line: test.location.line,
      suite: relativeFile.includes('/api/') ? ('api' as const) : ('e2e' as const),
      tags: test.tags,
      status,
      expectedStatus: test.expectedStatus === 'failed' ? ('failed' as const) : ('passed' as const),
      flaky,
      attempts: Math.max(attempts.length, 1),
      durationMs: attempts.reduce((sum, a) => sum + a.duration, 0),
      startedAt: last?.startTime?.toISOString(),
      workerIndex: last?.workerIndex,
      error,
      artifacts: this.toArtifacts(attempts, root),
      groundTruth: this.deriveGroundTruth(status, flaky, declaredDefects, injection, error),
    };
  }

  private statusOf(outcome: ReturnType<TestCase['outcome']>, last: TestResult | undefined) {
    if (outcome === 'skipped') return 'skipped' as const;
    if (outcome === 'expected' || outcome === 'flaky') return 'passed' as const;
    if (last?.status === 'timedOut') return 'timedOut' as const;
    if (last?.status === 'interrupted') return 'interrupted' as const;
    return 'failed' as const;
  }

  private toError(error: TestError) {
    const message = clean(error.message);
    const { expected, actual } = extractExpectedActual(message);

    return {
      message,
      stack: clean(error.stack) || undefined,
      snippet: clean(error.snippet) || undefined,
      expected,
      actual,
      locator: extractLocator(message),
      signature: signatureOf(message),
    };
  }

  private toArtifacts(attempts: TestResult[], root: string) {
    const all = attempts.flatMap((a) => a.attachments);
    const pick = (name: string) =>
      all.filter((a) => a.name === name && a.path).map((a) => posixRelative(root, a.path!));

    const screenshots = pick('screenshot');
    const video = pick('video')[0];
    const trace = pick('trace')[0];

    const artifacts: Record<string, unknown> = {};
    if (screenshots.length) artifacts.screenshots = screenshots;
    if (video) artifacts.video = video;
    if (trace) artifacts.trace = trace;

    return Object.keys(artifacts).length ? artifacts : undefined;
  }

  /**
   * Derives the correct answer for this result by joining the test's declared targets
   * against what the server actually had enabled.
   *
   * The important rule here is that it returns `undefined` rather than guessing. A
   * fabricated label is worse than a missing one: a missing label reduces the size of the
   * evaluation set, which is visible, whereas a wrong label silently corrupts every
   * accuracy figure computed from it and is almost impossible to detect later.
   */
  private deriveGroundTruth(
    status: string,
    flaky: boolean,
    declaredDefects: string[],
    injection: Injection,
    error: { message: string } | null
  ) {
    if (status === 'skipped') return undefined;
    if (status === 'passed' && !flaky) return { expectedClassification: 'pass' as const };

    const flakesEnabled = Object.keys(injection.flakes).length > 0;

    /**
     * Precedence matters here, and getting it wrong produces confidently mislabelled data.
     *
     * An always-on test bug cannot simply claim every failure of the spec it lives in. The
     * D051 spec fails under flake injection too — an intercepted click, not its brittle
     * selector — and labelling that `test-bug` would be wrong in the most damaging way,
     * since a classifier scored against it would be penalised for being right.
     *
     * So: an explicitly injected defect wins, because it was deliberately turned on. Flake
     * injection comes next. An always-on test bug is only credited when nothing else was
     * enabled that could account for the failure.
     */

    // 1. An injected defect this test declares. Unambiguous.
    const injected = declaredDefects.filter(
      (id) => ENTRY_BY_ID.has(id) && injection.defects.includes(id)
    );

    if (injected.length > 0) {
      const entry = ENTRY_BY_ID.get(injected[0]!)!;
      return {
        expectedClassification: entry.classification as
          | 'product-bug'
          | 'test-bug'
          | 'environment'
          | 'flake',
        defectIds: injected,
        notes: 'Derived from the test annotation joined against the server injection state.',
      };
    }

    // Nothing the test declared explains the failure. A 503 with flake injection enabled
    // is attributable to F004 with reasonable confidence.
    const looks503 = Boolean(error && /503|Service Unavailable/i.test(error.message));
    if (looks503 && (injection.defects.includes('D080') || 'F004' in injection.flakes)) {
      return {
        expectedClassification: 'environment' as const,
        defectIds: injection.defects.includes('D080') ? ['D080'] : ['F004'],
        notes: 'Inferred from a 503 response while infrastructure fault injection was active.',
      };
    }

    /**
     * No declared defect explains this, but if flake injection was the *only* thing
     * enabled then it is the only remaining cause, and the label is safe.
     *
     * The specific flake id stays unidentified on purpose. These failures are usually
     * cascades — an injected 503 surfacing three frames later as "received value must
     * have a length property", or an intercepted click surfacing as a visibility timeout
     * — so the error text names a symptom rather than the root cause. Guessing which
     * flake produced which cascade would be exactly the fabrication this method exists to
     * avoid; recording the class without the id is both honest and sufficient, since the
     * class is what a classifier is scored on.
     *
     * Note the tests carrying always-on test bugs resolve through the annotation branch
     * above, so they cannot be swallowed by this rule and mislabelled as flakes.
     */
    /**
     * 2b. Only infrastructure faults were injected.
     *
     * D080 rejects every request and D081 breaks authentication, so nothing downstream can
     * work. Most of the resulting failures never mention 503 — a failed login surfaces as
     * a visibility timeout three steps later — but every one of them is a cascade of an
     * environment problem, and the whole run is attributable on that basis alone.
     */
    const infraOnly =
      injection.defects.length > 0 &&
      !flakesEnabled &&
      injection.defects.every((id) => ENTRY_BY_ID.get(id)?.layer === 'infra');

    if (infraOnly) {
      return {
        expectedClassification: 'environment' as const,
        defectIds: [...injection.defects],
        notes:
          'Only infrastructure faults were injected, so every failure in this run is a ' +
          'cascade of an environment problem even where the surface error does not say so.',
      };
    }

    if (injection.defects.length === 0 && flakesEnabled) {
      return {
        expectedClassification: looks503 ? ('environment' as const) : ('flake' as const),
        notes:
          'Attributed to flake injection: no product defects were enabled and no declared ' +
          'defect explains this failure. The specific flake id is not identifiable from ' +
          'the evidence, which is typical of cascade failures.',
      };
    }

    /**
     * 3. An always-on test bug, credited only when nothing else was injected that could
     *    account for the failure. Under `test:reorder` — no defects, no flakes, only a
     *    legitimate catalog re-sort — this is the branch that correctly labels D051.
     */
    const testBugs = declaredDefects.filter((id) => ENTRY_BY_ID.get(id)?.layer === 'test');

    if (testBugs.length > 0 && !flakesEnabled && injection.defects.length === 0) {
      return {
        expectedClassification: 'test-bug' as const,
        defectIds: testBugs,
        notes:
          'Attributed to an always-on test bug: no faults were injected, so the spec ' +
          'itself is the only remaining explanation.',
      };
    }

    // Genuinely undetermined — several causes were active and none of them clearly owns
    // this failure. Deliberately unlabelled; see the note on this method.
    return undefined;
  }
}
