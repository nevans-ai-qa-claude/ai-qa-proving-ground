# Proving Ground

**Project 0 of an AI-in-QA portfolio.** A deliberately defective web application and API,
with toggleable fault injection and a baseline Playwright suite that emits structured run
events conforming to a shared contract.

It is not interesting on its own. It exists so that everything built on top of it can be
**measured** rather than merely demonstrated.

---

## The problem it solves

You can build an LLM-based failure triage system in an afternoon. Proving it works is the
hard part, and it is the part hiring managers care about.

Without ground truth, the strongest claim you can make is *"the model produced plausible
output."* With ground truth you can say *"89% precision on flake classification across 412
labelled runs, with the confusion matrix below, and here are the two categories it
consistently gets wrong."*

That difference is the entire distance between a toy and a portfolio piece. This repository
is the ground truth.

---

## Requirements

**Node 20 or later.** Node 16 and 18 are past end-of-life and the toolchain here does not
support them.

```bash
node --version
```

If that prints anything below v20, install a current LTS release before continuing.

---

## Quickstart

```bash
npm install
```

```bash
npx playwright install chromium
```

```bash
npm run test:clean
```

That last command should be **entirely green**. If it is not, something is wrong with the
environment, and nothing downstream of this repository is trustworthy until it is fixed.

The three seeded test bugs pass here, which is the point of them — see
[latent by design](#the-test-bugs-are-latent-by-design) below.

To drive the app by hand:

```bash
npm run dev
```

Then open <http://localhost:3100> and sign in as `qa@example.com` / `correct-horse`.

---

## What is deliberately broken

Everything is catalogued in [`contracts/defects.json`](contracts/defects.json), which is
the authoritative answer key. Summary:

| Range | Kind | Count | Toggle |
|---|---|---|---|
| `D001`–`D049` | Product bugs — the application is wrong | 12 | `DEFECTS` |
| `D050`–`D079` | Test bugs — the *specs* are wrong, product is fine | 3 | always present, latent |
| `D080`–`D099` | Environment faults — infrastructure, not code | 2 | `DEFECTS` |
| `F001`–`F049` | Flakes — nondeterministic | 4 | `FLAKES` |

Each entry carries the classification a correct triage system should assign, plus a
`difficulty` rating.

### The confusion pairs

Roughly a third of the manifest is marked `hard`, and those entries are the reason an
accuracy figure computed here means anything. They are hard **in both directions**:

- **D002** is a genuine duplicate-order product bug that presents as intermittency, because
  the double-click sometimes loses the race. Any classifier treating intermittency as
  evidence of flakiness misclassifies it.
- **D012** (product bug) and **D052** (test bug) both present as order dependence. One is
  the application's fault, one is the spec's. **F003** makes it a three-way problem.
- **D010** (product bug: accepts tokens it should reject) and **D081** (environment: rejects
  tokens it should accept) hit the same endpoint from opposite directions.
- **F004** is probabilistic but classified `environment`, not `flake`. Nondeterminism is a
  property of the *symptom*; classification depends on where the fault *lives*.

Report accuracy stratified by difficulty. A system that scores well on `easy` and poorly on
`hard` is doing keyword matching, and the stratified numbers will say so.

### The test bugs are latent by design

D050, D051 and D052 **pass on a clean run**. That is deliberate, and it is the most
realistic thing in the repository — badly written tests do not announce themselves, they
sit green for months and then fail for reasons that look like product problems.

| | Passes when | Fails when |
|---|---|---|
| **D050** hardcoded sleep | machine is idle | under load or on slow CI |
| **D051** positional selector | catalog order is default | `npm run test:reorder` |
| **D052** order-dependent | file runs in order | shuffled, sharded, or run in isolation |

Their value is not that they fail often. It is that when they *do* fail, the correct
classification is `test-bug`, and a triage system that files a product ticket instead is
producing exactly the false positive that destroys a team's trust in automated triage.

---

## Fault injection

All control is by environment variable, so it composes with CI matrices and with the corpus
generator without a config-file layer in between.

```bash
DEFECTS=none           # clean baseline
DEFECTS=all            # everything
DEFECTS=D001,D006      # explicit list — unknown ids throw rather than silently no-op

FLAKES=none
FLAKES=all             # every flake at its manifest default probability
FLAKES=F001:0.5,F002   # explicit, with optional probability override

FLAKE_SEED=1337        # PRNG seed
```

### Ready-made run modes

| Command | What it produces |
|---|---|
| `npm run test:clean` | Baseline. Only the always-on test bugs should fail. |
| `npm run test:product` | The twelve product bugs. The most useful defect run. |
| `npm run test:defects` | Every defect, including `D080` — see the note below. |
| `npm run test:flaky` | Flakes only — the nondeterminism corpus. |
| `npm run test:chaos` | Everything at once. |
| `npm run test:reorder` | Legitimate catalog re-sort. Only the brittle-selector spec breaks. |
| `npm run test:parallel` | Four workers, surfacing order-dependence faults. |

`DEFECTS=all` includes `D080`, which rejects **every** request, so that run is a total
blackout in which nothing else is observable. It is a legitimate scenario and a useful
environment-classification case, but it is not the run you want for exercising the product
bugs. Use `npm run test:product` for that.

### On reproducibility — an honest caveat

`FLAKE_SEED` makes the *sequence of flake decisions* deterministic. It does **not** make a
run bit-for-bit reproducible under parallel workers, because the order in which requests
reach the server is not deterministic. For an exact repeat:

```bash
npx playwright test --workers=1
```

The suite defaults to one worker for this reason.

---

## The contract

[`contracts/run-event.schema.json`](contracts/run-event.schema.json) is the spine of the
whole portfolio. Every downstream project reads it; none of them import Playwright.

Runs are written to `artifacts/runs/<runId>.json`. Validate them with:

```bash
npm run validate:events
```

Three fields deserve attention:

**`error.signature`** — the error message with everything variable (numbers, uuids,
timestamps, paths, quoted literals) replaced by placeholders. Identical root causes collapse
to identical signatures, so you can cluster deterministically *before* spending a single
token on a model. This is the field that makes triage cheap.

**`injection`** — which faults were active and what seed was used. Read from the *server*,
not from the runner's own environment, because the two are separate processes and can drift
apart. It makes an archived run self-describing.

**`groundTruth`** — the correct answer, derived automatically by joining each test's
annotations against the server's injection state. It is explicitly optional and marked
non-authoritative. **Consumers must not read it at inference time.** When the label cannot
be derived, the reporter omits it rather than guessing — a missing label shrinks the
evaluation set visibly, whereas a fabricated one corrupts every figure computed from it
invisibly.

### How labels are derived, and in what order

Precedence is the whole game here. Getting it wrong produces data that is confidently
wrong, which is worse than data that is missing.

1. **An injected defect the test declares.** Unambiguous — it was deliberately switched on.
2. **Infrastructure-only runs.** D080 rejects every request and D081 breaks authentication,
   so nothing downstream can work. Most failures never mention 503 (a failed login surfaces
   as a visibility timeout three steps later) but all of them are `environment`.
3. **Flake injection alone.** No product defects enabled, so flakes are the only remaining
   cause. The specific flake id is left unidentified on purpose: these are cascades, and
   guessing which flake produced which cascade would be fabrication.
4. **An always-on test bug**, credited only when nothing else was injected.
5. **Otherwise, no label.**

Step 4 sitting *below* step 3 is the subtle part. An always-on test bug cannot claim every
failure of the spec it lives in — the D051 spec also fails under flake injection, from an
intercepted click rather than its brittle selector. Labelling that `test-bug` would penalise
a classifier for being right.

### Verified scenario matrix

Measured, not asserted. Flake runs use `FLAKE_SEED=7`; being probabilistic, their exact
counts vary by seed.

| Scenario | failed | flaky | unlabelled | classifications |
|---|---|---|---|---|
| `clean` | 0 | 0 | 0 | pass 29 |
| all 12 product bugs | 15 | 0 | 0 | product-bug 15, pass 14 |
| `flakes` (all) | 6 | 2 | 0 | flake 7, environment 1, pass 21 |
| `reorder` | 1 | 0 | 0 | test-bug 1, pass 28 |
| `D080` blackout | 29 | 0 | 0 | environment 29 |
| `D081` clock skew | 20 | 0 | 0 | environment 20, pass 9 |
| `chaos` (all + all) | 29 | 0 | 5 | product-bug 15, environment 9 |

The five unlabelled results under `chaos` are the design working as intended: with defects
and flakes both active and no single cause clearly owning the failure, the reporter declines
to guess.

---

## Building a labelled corpus

```bash
npm run corpus
```

90 runs across isolated defects, flake scenarios at several seeds, test-bug isolation runs,
worker-contention runs and combinations. Isolated single-defect runs are what make
attribution learnable; combinations then test whether it holds up under co-occurrence. A
corpus of nothing but chaos runs teaches very little, because every failure co-occurs with
every other.

### Measured composition

90 runs, 2,498 results, 376 non-pass labelled, 17 unlabelled, 90/90 schema-valid.

| Class | Count | Share of non-pass |
|---|---|---|
| environment | 145 | 38.6% |
| flake | 130 | 34.6% |
| product-bug | 91 | 24.2% |
| test-bug | 10 | 2.7% |

**`test-bug` is structurally underrepresented, and more runs will not fix it.** There are
only three test bugs in the manifest, and D050 (the hardcoded sleep) needs real load to
fire. Repeats would add count without adding diversity. The fix is more *distinct* badly
written tests — a duplicated assertion, a test that asserts on a locale-formatted date, one
that depends on a fixture it never requested — not more executions of the same three.

Treat 2.7% as a known limitation when reporting any per-class metric, and weight accordingly.

### The ceiling on evidence-only classification

Measured across the corpus: how much can deterministic clustering achieve before any model
call, and how pure are the resulting clusters?

| Cluster key | Clusters | Pure | Ceiling |
|---|---|---|---|
| signature only | 31 | 12 | 9.3% |
| testId + signature | 51 | 20 | 20.2% |
| testId + expected/actual | 66 | 37 | 34.3% |

**Even the best key tops out at ~34%.** This is not a normalisation bug. The same test
failing with byte-identical evidence is a product bug in one run and a flake in another,
and from a single failure those are genuinely indistinguishable.

The discriminator is **cross-run frequency**, which lives in the corpus rather than in any
individual result. A test failing 3% of the time is a flake; the same test failing on every
run since a given commit is a product bug. Any classifier built on this contract should
consume run *history*, not one failure at a time — that feature will move the number far
more than better prompting will.

For reference, the archived v1 corpus scored 41.7% on the best key. v2 scores lower because
it is harder, not because it regressed: v1 was 14.7% flake mass against v2's 34.6%, and
flakes are the class that collides with product bugs. A corpus that flattered a classifier
would be the failure mode, not the goal.

---

## Verifying the answer key

Two checks, at different costs.

**Fast, every commit** — structural consistency between the manifest, the application code
and the specs:

```bash
npm run check:consistency
```

It catches the drift that keeps the suite green while quietly making the corpus wrong: a
manifest entry nothing gates on, a defect no spec is annotated against, a `defectOn()` call
naming an id that no longer exists and therefore silently does nothing. It found a real bug
during the initial build — F003 was catalogued as toggleable but implemented as
structurally always-on, which would have made it impossible to generate the F003-free runs
needed to isolate D012 from D052.

**Slow, on a schedule** — proof that each defect genuinely fails the test that claims to
catch it:

```bash
npm run verify:manifest
```

Enables each defect alone and asserts the test that claims to detect it actually failed.

This is the test suite for the test suite. If the manifest claims D006 is caught by a given
spec and that link quietly breaks, every accuracy number computed from the corpus becomes
meaningless while continuing to look entirely plausible. Slow — one full suite execution per
defect — so it belongs on a CI schedule, not in the inner loop.

---

## Repository layout

```
contracts/          The spine. Imports nothing; everything depends on it.
  run-event.schema.json
  defects.json                  the answer key
src/
  faults.ts         injection control plane and seeded PRNG
  routes.ts         API, with every defect site annotated by id
  store.ts          in-memory data, resettable
  public/           hand-authored DOM (deliberately — see below)
tests/
  fixtures.ts       auto-reset, auth helpers, the targets() annotation helper
  api/              API specs
  e2e/              browser specs, including the three seeded test bugs
reporters/
  run-event-reporter.ts         the contract producer
scripts/
  generate-corpus.ts
  validate-events.ts
  verify-manifest.ts
```

### Why the frontend has no framework

The DOM is hand-authored on purpose. The self-healing-locator project needs markup whose
structure is precisely controlled, so that a brittle selector (`.product-card:nth-child(3)`)
and its known-good replacement (`[data-product-id="p-003"]`) both exist on the same element
and heal accuracy can be *measured* rather than eyeballed. Framework-generated markup would
make that much harder to reason about.

### Why the test suite contains bad tests

D050, D051 and D052 are deliberately badly written — a hardcoded sleep, a positional
selector, an order-dependent assertion. They are not oversights; they are the test-bug
ground truth. Without them a classifier has no negative examples and will happily blame the
product for every failure, which is exactly the false-positive behaviour that destroys trust
in automated triage.

---

## What this repository does *not* do

No AI. Not a single model call, no API key, no token spend.

That is deliberate. This is the measuring instrument, and an instrument that shared
components with the thing it measures would not be worth much. The AI lives in the projects
downstream:

1. **Failure triage and clustering** — consumes `artifacts/runs/*.json`, scored against
   `groundTruth`.
2. **Self-healing locators** — consumes the DOM artifacts and D051.
3. **LLM evaluation harness** — a different problem, same contract.
4. **Mutation-scored test generation** — generates specs for this app and proves they kill
   mutants.

---

## Known limitations

- Flake reproducibility is seed-narrowed, not exact, under parallel workers (above).
- The `_test/reset` endpoint is global, so the auto-reset fixture is only safe at
  `workers: 1`. `test:parallel` exists to exercise contention deliberately, and its results
  should be read as a different corpus rather than as a cleaner version of the default one.
- `groundTruth` derivation depends on test annotations staying accurate. `verify:manifest`
  is what catches drift; run it on a schedule.
- The in-memory store means no persistence-layer defects. A database-backed variant would
  add a genuinely different failure class, and is not currently modelled.
