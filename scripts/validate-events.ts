/**
 * Validates every emitted run event against the contract.
 *
 * Run this in CI. A producer that quietly drifts from the schema is the single most
 * expensive failure mode in a portfolio built around a shared contract: nothing breaks
 * loudly, consumers just start seeing fields that are missing or the wrong shape, and the
 * damage surfaces weeks later as inexplicable analysis results.
 */

import fs from 'node:fs';
import path from 'node:path';
// Ajv's default export only understands draft-07. The contract is draft 2020-12, which
// needs this build — otherwise compile() throws "no schema with key or ref
// https://json-schema.org/draft/2020-12/schema", which reads like a network problem and
// is nothing of the sort.
import Ajv from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

import schema from '../contracts/run-event.schema.json';

const RUNS_DIR = path.resolve(__dirname, '..', 'artifacts', 'runs');

function main() {
  if (!fs.existsSync(RUNS_DIR)) {
    console.error(`No runs directory at ${RUNS_DIR}. Execute the suite first.`);
    process.exit(1);
  }

  const files = fs.readdirSync(RUNS_DIR).filter((f) => f.endsWith('.json'));
  if (files.length === 0) {
    console.error('No run events found. Execute the suite first.');
    process.exit(1);
  }

  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);

  let failures = 0;

  for (const file of files) {
    const payload: unknown = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, file), 'utf8'));

    // Read the count before validating. Ajv's validate() is a type guard, so inside the
    // success branch `payload` is narrowed to the schema-inferred type and the compiler
    // loses sight of the shape we actually parsed.
    const resultCount = Array.isArray((payload as { results?: unknown[] })?.results)
      ? (payload as { results: unknown[] }).results.length
      : 0;

    if (validate(payload)) {
      console.log(`  ok    ${file}  (${resultCount} results)`);
      continue;
    }

    failures += 1;
    console.error(`  FAIL  ${file}`);
    for (const error of validate.errors ?? []) {
      console.error(`          ${error.instancePath || '/'} ${error.message}`);
    }
  }

  console.log(`\n  ${files.length - failures}/${files.length} run events valid.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
