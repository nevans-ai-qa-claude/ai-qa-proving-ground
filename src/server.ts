import { createApp } from './app';
import { describeActiveFaults } from './faults';

const port = Number(process.env.PORT ?? 3100);

createApp().listen(port, () => {
  // Printing the active fault set on boot is not decoration. When a run produces a
  // surprising result, the first question is always "what was actually enabled?", and
  // having the answer at the top of the server log saves re-deriving it from env vars.
  console.log(`\n  proving-ground listening on http://localhost:${port}`);
  console.log(`  ${describeActiveFaults()}\n`);
});
