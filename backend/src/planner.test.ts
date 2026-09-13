import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import { buildPlanForCourses } from './planner';
import { closeSteelPool } from './courses/steelPool';

dotenv.config();
after(() => closeSteelPool());

// Kept to a couple of real, cheap courses so this stays fast and light on Steel sessions
// while still exercising the full pipeline: calendar scrape -> retrieveTree -> ttb offerings
// -> section selection.
test('buildPlanForCourses places an already-satisfiable course into semester 1 with real section data', async () => {
  const plan = await buildPlanForCourses({ requiredCourses: ['CSCA08H3'], electiveGroups: [] }, ['Test Program'], {
    completedCourses: [],
    semesters: 1,
  });

  assert.deepEqual(plan.programs, ['Test Program']);
  assert.equal(plan.semesters.length, 1);
  const semester1 = plan.semesters[0]!;
  const placed = semester1.courses.find((c) => c.code === 'CSCA08H3');
  assert.ok(placed, `expected CSCA08H3 to be placed, stillNeeded: ${plan.stillNeeded.join(', ')}, warnings: ${plan.warnings.join('; ')}`);
  assert.ok(placed!.session === 'F' || placed!.session === 'S' || placed!.session === 'Y');
  assert.ok(placed!.sections && placed!.sections.length > 0);
});

test('buildPlanForCourses defers a course to a later semester until its prerequisite is met', async () => {
  const plan = await buildPlanForCourses({ requiredCourses: ['CSCA08H3', 'CSCA48H3'], electiveGroups: [] }, ['Test Program'], {
    completedCourses: [],
    semesters: 2,
  });

  const semester1Codes = plan.semesters[0]!.courses.map((c) => c.code);
  const semester2Codes = plan.semesters[1]!.courses.map((c) => c.code);

  assert.ok(semester1Codes.includes('CSCA08H3'));
  // CSCA48H3 requires CSCA08H3, so it should not land in the same semester as it.
  assert.ok(!semester1Codes.includes('CSCA48H3'));
  assert.ok(semester2Codes.includes('CSCA48H3') || plan.stillNeeded.includes('CSCA48H3'));
});

test('buildPlanForCourses treats a completed exclusion as satisfying the requirement', async () => {
  // CSC148H1's calendar entry lists CSCA48H3 as an exclusion (they cover the same material
  // at different campuses), so someone who already took CSCA48H3 shouldn't be told to take
  // CSC148H1 too.
  const plan = await buildPlanForCourses({ requiredCourses: ['CSC148H1'], electiveGroups: [] }, ['Test Program'], {
    completedCourses: ['CSCA48H3'],
    semesters: 1,
  });

  // Nothing left to schedule, so the plan shouldn't even produce an empty semester.
  assert.deepEqual(plan.semesters, []);
  assert.deepEqual(plan.stillNeeded, []);
});

test('buildPlanForCourses stops once every requirement is placed when semesters is left unset', async () => {
  const plan = await buildPlanForCourses(
    { requiredCourses: ['CSCA08H3'], electiveGroups: [] },
    ['Test Program'],
    { completedCourses: [] } // no semesters given -> plan to completion
  );

  assert.ok(plan.semesters.length >= 1);
  const allPlaced = plan.semesters.flatMap((s) => s.courses.map((c) => c.code));
  assert.ok(allPlaced.includes('CSCA08H3'));
  assert.deepEqual(plan.stillNeeded, []);
  // Shouldn't keep adding empty trailing semesters after the single requirement is met.
  assert.ok(plan.semesters.length < 5, `expected the plan to stop quickly once satisfied, got ${plan.semesters.length} semesters`);
});

test('buildPlanForCourses treats an elective group as "choose N", not "take all"', async () => {
  const plan = await buildPlanForCourses(
    { requiredCourses: [], electiveGroups: [{ description: 'Breadth pick', chooseCount: 1, options: ['CSCA08H3', 'CSCA67H3'] }] },
    ['Test Program'],
    { completedCourses: [], semesters: 1 }
  );

  const placedCodes = plan.semesters[0]!.courses.map((c) => c.code);
  // Both options have no prereqs and are both offered in Fall, so a naive "flatten to
  // required" bug would place both. Only one should be attempted since chooseCount is 1.
  assert.equal(placedCodes.length, 1, `expected exactly one course placed, got: ${placedCodes.join(', ')}`);
  assert.deepEqual(plan.electiveGroupsRemaining, []);
});
