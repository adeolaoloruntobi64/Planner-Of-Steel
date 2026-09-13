import { test } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import { getProgramRequirements } from './cache';

dotenv.config();

// Regression test: SCSPE0795C's own requirements text doesn't list its academic course
// requirements at all — it says "Students must complete the program requirements as described
// in the Specialist Program in Computer Science" and only lists its own co-op-specific extras
// (prep seminars, work terms). Without resolving that cross-reference, the planner thought this
// co-op specialist needed almost nothing beyond first year + co-op courses, and buried that gap
// under many semesters of generic "free elective" filler instead of real upper-year CS courses.
test('getProgramRequirements merges in a cross-referenced base program\'s requirements for a co-op stream', async () => {
  const coop = await getProgramRequirements('utsc', 'Computer-Science', 'SCSPE0795C');
  const base = await getProgramRequirements('utsc', 'Computer-Science', 'SCSPE0795');

  // The co-op variant's own text only lists ~10 courses (first year + co-op); the merged
  // result should include the base program's much larger upper-year requirement list too.
  assert.ok(
    coop.requiredCourses.length >= base.requiredCourses.length,
    `expected the co-op program's merged requirements (${coop.requiredCourses.length}) to be at least as large as the base program's (${base.requiredCourses.length})`
  );
  for (const code of base.requiredCourses) {
    assert.ok(coop.requiredCourses.includes(code), `expected base requirement ${code} to be merged into the co-op program's requirements`);
  }
  // Its own co-op-specific requirements should still be present too, not replaced.
  for (const code of ['COPB50H3', 'COPC01H3', 'COPC02H3', 'COPC03H3']) {
    assert.ok(coop.requiredCourses.includes(code), `expected co-op-specific requirement ${code} to still be present`);
  }
});
