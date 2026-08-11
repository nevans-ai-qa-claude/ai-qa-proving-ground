# Contracts

This directory is the spine of the whole portfolio. Nothing in here imports anything.
Everything else in every repo depends on it.

## `run-event.schema.json`

The canonical record of one test execution. JSON Schema draft 2020-12, deliberately
language-neutral so the TypeScript test harness and the Python analysis services can
both bind to it without one owning the other.

**Producers** write it: the Playwright reporter in this repo, and later any harness you
point at it.

**Consumers** read it: failure triage, risk-based test selection, the QA MCP server, the
capstone dashboard.

### Three design decisions worth knowing

**1. `testId` must be stable.**
It is a hash of the repo-relative file path plus the full title path. It cannot include
line numbers, run ids, or timestamps, because downstream history correlation — "what is
the flake rate of this test over 90 days" — breaks the moment a test's identity changes
for a reason unrelated to the test.

**2. `injection` makes a run self-describing.**
It records which defects and flakes were active and what PRNG seed was used. Six months
from now you can look at an archived run and know exactly what was wrong with the system
under test. Real-world producers emit empty arrays; the proving ground fills it in.

**3. `groundTruth` is quarantined.**
It carries the correct answer for each result, but it is explicitly marked
non-authoritative and optional. Classifiers must not read it at inference time. It exists
so you can score them afterwards. Keeping the label in the same document as the evidence
is convenient; keeping it clearly fenced off is what stops that convenience turning into
leakage.

### `error.signature`

The normalised form of an error message — numbers, uuids, timestamps, hex, quoted
strings and file paths replaced with placeholders. Two failures with the same root cause
produce the same signature, so you can cluster deterministically *before* spending a
single token on a model. This is the field that makes triage cheap.

### Versioning

`schemaVersion` is semver.

- **Patch** — documentation, description changes.
- **Minor** — new optional fields. Consumers ignore what they do not recognise.
- **Major** — anything that removes or repurposes a field. Consumers must reject majors
  they were not written against, loudly, rather than silently misreading data.

## `defects.json`

The answer key. See its own `notes` block for the schema. Every fault the proving ground
can inject is listed there with the classification a correct triage system should assign.
