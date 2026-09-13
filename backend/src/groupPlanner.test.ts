import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import { buildGroupPlan } from './groupPlanner';
import type { ProgramSelector } from './planner';
import { closeSteelPool } from './courses/steelPool';
import { writeTestOutput } from './testSupport';

dotenv.config();
after(() => closeSteelPool());

// Slow (drives 2 real plan builds plus live Steel/Claude calls) — run standalone with
// `npx tsx --test src/groupPlanner.test.ts` during iteration rather than the full `npm test`.
const CS_PROGRAM: ProgramSelector = { campus: 'utsc', sectionSlug: 'Computer-Science', programCode: 'SCMAJ1688' };

test('buildGroupPlan plans each friend independently and suggests a shared course for a take-together request', async () => {
  const plan = await buildGroupPlan({
    friends: [
      { name: 'Alice', completedCourses: ['CSCA08H3', 'CSCA48H3'], programs: [CS_PROGRAM] },
      { name: 'Bob', completedCourses: ['CSCA08H3'], programs: [CS_PROGRAM] },
    ],
    constraintsPrompt: 'Alice and Bob want to take a course together',
    semesters: 2,
  });
  writeTestOutput('groupPlanner-take-together', plan);

  assert.equal(plan.friends.length, 2);
  for (const f of plan.friends) {
    assert.ok(f.plan.semesters.length > 0, `expected ${f.name} to get a real plan, warnings: ${f.plan.warnings.join('; ')}`);
  }

  // A shared suggestion isn't guaranteed (it depends on live prereq/offering data), but if the
  // constraint was understood at all, it should name both friends and a real course code.
  if (plan.sharedSuggestions.length > 0) {
    const suggestion = plan.sharedSuggestions[0]!;
    assert.equal(suggestion.constraintType, 'take-together');
    assert.deepEqual(new Set(suggestion.friendNames), new Set(['Alice', 'Bob']));
    assert.match(suggestion.code, /^[A-Z]{3,4}\d{2,3}[HY][135]$/);
  } else {
    assert.ok(plan.warnings.length > 0, 'expected either a suggestion or an explanatory warning, got neither');
  }
});
