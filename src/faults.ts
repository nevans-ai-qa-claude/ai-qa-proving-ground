/**
 * Fault injection control plane.
 *
 * Every deliberate defect in this application is gated behind `defectOn(id)`, and
 * every nondeterministic fault behind `flakeFires(id)`. Nothing is hardcoded broken.
 *
 * The reason is that downstream projects need a *labelled corpus* — many runs where the
 * correct answer is known — in order to score a triage classifier. That requires being
 * able to say "give me a run with exactly D006 and D008 active, nothing else". Hardcoded
 * bugs would give you one scenario and no clean baseline to compare against.
 */

import manifest from '../contracts/defects.json';

type Manifest = {
  defects: Array<{ id: string; classification: string; title: string; layer: string }>;
  flakes: Array<{ id: string; classification: string; title: string; defaultProbability: number }>;
};

const MANIFEST = manifest as unknown as Manifest;

const ALL_DEFECT_IDS = MANIFEST.defects
  // Test bugs live in the spec files, not here. They are always "on" and cannot be
  // toggled from the server, so they are excluded from the injectable set.
  .filter((d) => d.layer !== 'test')
  .map((d) => d.id);

const ALL_FLAKE_IDS = MANIFEST.flakes.map((f) => f.id);

const DEFAULT_PROBABILITY = new Map(MANIFEST.flakes.map((f) => [f.id, f.defaultProbability]));

/* -------------------------------------------------------------------------- */
/* Parsing                                                                     */
/* -------------------------------------------------------------------------- */

function parseDefects(raw: string | undefined): Set<string> {
  const value = (raw ?? 'none').trim();
  if (value === '' || value === 'none') return new Set();
  if (value === 'all') return new Set(ALL_DEFECT_IDS);

  const ids = value.split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = ids.filter((id) => !ALL_DEFECT_IDS.includes(id));
  if (unknown.length > 0) {
    // Fail loudly. A typo'd defect id that silently does nothing would poison an entire
    // corpus with mislabelled runs, and you would not find out until the scoring step.
    throw new Error(
      `Unknown defect id(s): ${unknown.join(', ')}. ` +
        `Injectable ids are: ${ALL_DEFECT_IDS.join(', ')}`
    );
  }
  return new Set(ids);
}

function parseFlakes(raw: string | undefined): Map<string, number> {
  const value = (raw ?? 'none').trim();
  const out = new Map<string, number>();
  if (value === '' || value === 'none') return out;

  if (value === 'all') {
    for (const id of ALL_FLAKE_IDS) out.set(id, DEFAULT_PROBABILITY.get(id) ?? 0.25);
    return out;
  }

  for (const entry of value.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [id, probability] = entry.split(':').map((s) => s.trim());
    if (!id || !ALL_FLAKE_IDS.includes(id)) {
      throw new Error(`Unknown flake id: ${id}. Known ids are: ${ALL_FLAKE_IDS.join(', ')}`);
    }
    const p = probability === undefined ? DEFAULT_PROBABILITY.get(id) ?? 0.25 : Number(probability);
    if (!Number.isFinite(p) || p < 0 || p > 1) {
      throw new Error(`Flake ${id} probability must be between 0 and 1, got: ${probability}`);
    }
    out.set(id, p);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Seeded PRNG                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * mulberry32 — small, fast, adequately distributed. Not cryptographic, and it does not
 * need to be; it needs to be *reproducible*, which Math.random() is not.
 *
 * Caveat worth understanding: seeding makes the sequence of decisions deterministic, but
 * a run is only reproducible end to end if requests arrive in a deterministic order. With
 * parallel Playwright workers they do not. Run with `--workers=1` for a bit-for-bit repeat.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* -------------------------------------------------------------------------- */
/* Public surface                                                              */
/* -------------------------------------------------------------------------- */

export const activeDefects = parseDefects(process.env.DEFECTS);
export const activeFlakes = parseFlakes(process.env.FLAKES);
export const flakeSeed = Number(process.env.FLAKE_SEED ?? 1337);

const random = mulberry32(flakeSeed);

/** True when the named deterministic defect is enabled for this process. */
export function defectOn(id: string): boolean {
  return activeDefects.has(id);
}

/** Rolls the seeded PRNG. True when the named flake should fire on this occasion. */
export function flakeFires(id: string): boolean {
  const probability = activeFlakes.get(id);
  if (probability === undefined) return false;
  return random() < probability;
}

/**
 * Config-level check: is this flake enabled at all, irrespective of any dice roll?
 *
 * F003 needs this rather than `flakeFires`. Its nondeterminism does not come from a
 * probability — it comes from parallel workers contending over shared server state. A
 * per-request roll would be actively wrong: the write could land in the shared list while
 * the read came from the per-session one, producing an incoherent failure that models
 * nothing real. Enablement is the switch; contention supplies the nondeterminism.
 */
export function flakeEnabled(id: string): boolean {
  return activeFlakes.has(id);
}

/** A seeded random integer in [min, max]. Used for injected jitter and delays. */
export function jitter(min: number, max: number): number {
  return Math.floor(random() * (max - min + 1)) + min;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The injection block for the run-event contract. Served over HTTP so the test reporter
 * can record what the *server* actually had enabled, rather than trusting that the test
 * process and the server process were configured identically. They are separate
 * processes; assuming they agree is how corpora get silently mislabelled.
 */
export function injectionState() {
  return {
    defects: [...activeDefects].sort(),
    flakes: Object.fromEntries([...activeFlakes.entries()].sort(([a], [b]) => a.localeCompare(b))),
    seed: flakeSeed,
  };
}

export function describeActiveFaults(): string {
  const d = activeDefects.size === 0 ? 'none' : [...activeDefects].sort().join(', ');
  const f =
    activeFlakes.size === 0
      ? 'none'
      : [...activeFlakes.entries()].map(([id, p]) => `${id}@${p}`).join(', ');
  return `defects: ${d}\n  flakes:  ${f}\n  seed:    ${flakeSeed}`;
}
