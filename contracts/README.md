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

`schemaVersion` is semver, and it versions the **contract**, not the file. The distinction
matters: a producer can change what a field *means* without changing a single character of
this schema, and a consumer pinned to the old version would be silently misled.

- **Patch** — documentation and description changes only. No consumer needs to react.
- **Minor** — new optional fields, *or a change in how an existing field is computed that
  does not change its type or break a consumer that reads it naively*. Consumers ignore
  fields they do not recognise, and continue working with the new semantics.
- **Major** — anything that removes a field, changes its type, or repurposes it such that
  an existing consumer would misread it. Consumers must reject majors they were not written
  against, loudly, rather than silently misreading data.

**Semantic changes count.** This clause was added after `error.signature` was made less
aggressive: the JSON Schema was byte-identical before and after, but the normalisation
underneath changed enough to alter every downstream clustering result. Nothing in a
shape-only versioning policy would have caught that, and a consumer pinned to the previous
tag would have quietly started producing different numbers with no signal that anything had
moved.

The rule of thumb: version the **observable behaviour of the data**, not the file that
describes its shape. If a consumer would compute a different answer from the same run, that
is a version change, however small the diff.

### Tags

Each contract version is an annotated git tag. Downstream projects pin to a tag rather than
tracking `main`.

| Tag | Contract | Notes |
|---|---|---|
| `contract-v1.0.0` | 1.0.0 | Initial schema and answer key. |
| `contract-v1.1.0` | 1.1.0 | `error.signature` normalisation relaxed — plain numbers and quoted literals are preserved. Same shape, different clustering behaviour. |

## `defects.json`

The answer key. See its own `notes` block for the schema. Every fault the proving ground
can inject is listed there with the classification a correct triage system should assign.
