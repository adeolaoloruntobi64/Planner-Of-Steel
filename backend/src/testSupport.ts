import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Human-inspectable dump of what a test actually got back from a real transcript-parsing or
// planning run — not asserted on, just written out so results can be eyeballed directly
// instead of re-running the (slow, Claude/Steel-backed) test to see the output again.
const OUTPUT_DIR = join(__dirname, '..', 'test-output');

export function writeTestOutput(name: string, data: unknown): void {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const safeName = name.replace(/[^a-z0-9-_]+/gi, '_');
  writeFileSync(join(OUTPUT_DIR, `${safeName}.json`), JSON.stringify(data, null, 2));
}
