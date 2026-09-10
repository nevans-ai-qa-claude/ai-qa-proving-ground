# Proving Ground

**Project 0 of an AI-in-QA portfolio.** A deliberately defective web application and API,
with toggleable fault injection and a baseline Playwright suite that emits structured run
events conforming to a shared contract.

Part of [nevans-ai-qa-claude](https://github.com/nevans-ai-qa-claude) — a series exploring
how far AI can usefully be pushed into a test automation workflow, and where it should not
go. This repository is the measuring instrument the rest are scored against.

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
| `D050`–`D079` | Test bugs — the *specs* are wrong, product is fine | 8 | always present, latent |
| `D080`–`D099` | Environment faults — infrastructure, not code | 2 | `DEFECTS` |
| `F001`–`F049` | Flakes — nondeterministic | 4 | `FLAKES` |

Each entry carries the classification a correct triage system should assign, plus a
`difficulty` rating.

### The confusion pairs

Five of the twenty-two catalogued defects are marked `hard` (against nine `easy` and eight
`moderate`), and those entries are the reason an accuracy figure computed here means
anything. They are hard **in both directions**:

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

All eight test bugs **pass on a clean run**. That is deliberate, and it is the most
realistic thing in the repository — badly written tests do not announce themselves, they
sit green for months and then fail for reasons that look like product problems.

Every trigger below is *legitimate product work*, not a defect. That constraint is forced
rather than stylistic: label precedence puts flake attribution above always-on test bugs,
so a test bug that only fired under `FLAKES` would be labelled `flake` and would make the
corpus worse instead of better.

| | Passes when | Fails when |
|---|---|---|
| **D050** hardcoded sleep | machine is idle | under load or on slow CI |
| **D051** positional selector | catalog order is default | `npm run test:reorder` |
| **D052** order-dependent | file runs in order | shuffled, sharded, or run in isolation |
| **D053** hard-coded currency string | default locale | `LOCALE=de-DE`, an i18n rollout |
| **D054** hard-coded catalog count | catalog is default size | `CATALOG_EXTRA=1` |
| **D055** locator by visible copy | default button copy | `BUTTON_COPY=uk` |
| **D056** over-specific ancestor chain | default markup | `WRAP_CARDS=1` |
| **D057** index-based match on a shared class | catalog is default size | `CATALOG_EXTRA=1` |

D055 through D057 are also the seed cases for the self-healing-locator project: each has a
known-correct replacement on the same element, so heal accuracy can be measured rather
than eyeballed.

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

138 runs across 34 scenario groups: isolated defects, flake scenarios at several seeds,
test-bug isolation runs, worker-contention runs, episode windows and combinations. Isolated
single-defect runs are what make attribution learnable; combinations then test whether it
holds up under co-occurrence. A corpus of nothing but chaos runs teaches very little,
because every failure co-occurs with every other.

### Or download the frozen one

Generating your own produces a corpus of the same *shape* but not the same *data* — flake
outcomes are seeded per scenario and are not bit-for-bit reproducible under parallel
workers. Every figure published by this project and by
[ai-qa-failure-triage](https://github.com/nevans-ai-qa-claude/ai-qa-failure-triage) is
computed against one pinned corpus, downloadable here:

**[corpus-v2](https://github.com/nevans-ai-qa-claude/ai-qa-proving-ground/releases/tag/corpus-v2)**
— 138 runs, contract 1.2.0, 453 KB.

```bash
curl -L -o corpus-v2.zip https://github.com/nevans-ai-qa-claude/ai-qa-proving-ground/releases/download/corpus-v2/corpus-v2.zip
unzip corpus-v2.zip -d artifacts/
```

```
sha256  4fd26ab630103d1075b59e2676b9ebe67190e0e97079a15e7eefd37fd40a57f6
```

Comparisons across corpus versions are not meaningful — class composition moves between
them, and macro-averaged scores move with it. Cite the tag alongside any number.

### Measured composition

Corpus v2, the frozen release this repository publishes: 138 runs, 4,560 results, 382
non-pass labelled, 52 unlabelled, 138/138 schema-valid.

| Class | Count | Share of non-pass |
|---|---|---|
| product-bug | 117 | 30.6% |
| environment | 117 | 30.6% |
| flake | 84 | 22.0% |
| test-bug | 64 | 16.8% |

The 52 unlabelled results are the design working as intended: where defects and flakes are
both active and no single cause clearly owns the failure, the reporter declines to guess.

**`test-bug` used to be the structural weakness here and no longer is.** An earlier snapshot
of this corpus carried only 10 test-bug results, 2.7% of non-pass, off the back of just
three test bugs in the manifest. That note prescribed the fix — more *distinct* badly
written tests rather than more executions of the same three — and the manifest now carries
eight, taking the class to 16.8%.

**Read every downstream comparison with that in mind.** A classifier's macro-averaged score
rises when an easy class grows, whether or not the classifier improved, and `test-bug` is
the class deterministic clustering resolves most reliably. Movement in the numbers reported
by [ai-qa-failure-triage](https://github.com/nevans-ai-qa-claude/ai-qa-failure-triage)
between corpus versions is substantially composition, not method. Comparisons are only
meaningful within a single frozen corpus.

### The ceiling on evidence-only classification

How much can deterministic clustering resolve before any model call? Regenerate with
`python -m triage ceiling` from the failure-triage checkout — these figures are computed
from the same key functions the classifier uses, so they cannot drift away from it.

| Cluster key | Clusters | Pure | Pure share | Majority ceiling |
|---|---|---|---|---|
| signature only | 32 | 15 | 13.9% | 65.4% |
| testId + signature | 60 | 28 | 30.4% | 71.7% |
| testId + expected/actual | 75 | 44 | 44.0% | 75.1% |

Two figures, because "ceiling" is ambiguous and the ambiguity matters. **Pure share** is the
fraction of labelled failures in clusters whose members all carry one classification — the
cases resolved with no residual doubt. **Majority ceiling** counts mixed clusters at their
most common class, and is the true upper bound for any classifier using that key alone.

**The best key still leaves 24.9% unresolvable from single-failure evidence.** That is not a
normalisation bug. The same test failing with byte-identical evidence is a product bug in
one run and a flake in another, and from one failure those are genuinely indistinguishable.

It also bounds what a model can be expected to add. The deterministic baseline measures
69.2% accuracy against a 75.1% ceiling, so it already captures most of what its key can
deliver. The residual is not waiting on better prompting — it needs information that is not
present in a single failure.

The discriminator is **cross-run frequency**, which lives in the corpus rather than in any
individual result. A test failing 3% of the time is a flake; the same test failing on every
run since a given commit is a product bug. Any classifier built on this contract should
consume run *history*, not one failure at a time.

That remains a hypothesis about where the signal *should* be, and it is worth naming that
downstream attempts to exploit it have so far failed to beat clustering. A corpus that
flattered the hypothesis would be the failure mode, not the goal.

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
- **Run events do not record the product configuration that triggers a test bug.** The
  `injection` block captures `DEFECTS` and `FLAKES` faithfully, but the environment
  variables behind the test-bug scenarios — `LOCALE`, `CATALOG_ORDER`, `CATALOG_EXTRA`,
  `BUTTON_COPY`, `WRAP_CARDS` — are not written to the event. In corpus v2 that leaves 34
  runs indistinguishable from a clean run in the archived data, even though a specific
  legitimate configuration was active. Ground-truth labelling is unaffected, because it
  derives from the test annotations rather than from the event. But it does undercut the
  claim that an archived run is fully self-describing, and a reader cannot tell from the
  event alone why a test bug fired. Closing it means recording scenario configuration in
  `injection` and regenerating the corpus, which is a contract change.
