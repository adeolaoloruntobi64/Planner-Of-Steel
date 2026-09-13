import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import { getCourseOfferings } from './ttb';
import { closeSteelPool } from './steelPool';

dotenv.config();

after(() => closeSteelPool());

// Drives the real ttb.utoronto.ca Angular app through Steel, so this is slow (~15-30s)
// and network-dependent. Run on its own with `npx tsx --test src/courses/ttb.test.ts`
// when you need to check the live scraper, not on every quick iteration.
test('getCourseOfferings finds Fall and Winter sections for CSC148H1', async () => {
  const result = await getCourseOfferings('CSC148H1');

  assert.equal(result.code, 'CSC148H1');
  assert.equal(result.campus, 'stgeorge');

  const sessions = result.offerings.map((o) => o.session);
  assert.ok(sessions.includes('F'), `expected a Fall offering, got sessions: ${sessions.join(', ')}`);
  assert.ok(sessions.includes('S'), `expected a Winter offering, got sessions: ${sessions.join(', ')}`);

  const fall = result.offerings.find((o) => o.session === 'F');
  assert.ok(fall && fall.sections.length > 0, 'expected at least one section in the Fall offering');
  const lecture = fall!.sections.find((s) => s.type === 'LEC');
  assert.ok(lecture, 'expected a LEC section');
  assert.ok(lecture!.meetings.length > 0, 'expected at least one meeting time');
  assert.ok(lecture!.meetings[0]!.day.length > 0);
});
