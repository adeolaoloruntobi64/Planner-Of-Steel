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
  // Bounded (semesters given explicitly) should never add free-elective filler — that's
  // only for "plan to completion" mode.
  assert.ok(!semester1.courses.some((c) => c.code.startsWith('FREE-ELECTIVE-')));
});

test('buildPlanForCourses tops up a bounded preview semester toward a realistic course load, not just the bare requirement', async () => {
  // A student normally takes 4-5 half-courses (2.0-2.5 credits) a term. A bounded "show me the
  // next N semesters" preview used to stop as soon as the specific requirement list ran out
  // (here, just one required course), leaving an unrealistically light semester even though
  // other real, available, prereq-free courses exist to fill it out.
  const plan = await buildPlanForCourses(
    {
      requiredCourses: ['CSCA08H3'],
      electiveGroups: [{ description: 'known extra options', chooseCount: 0, options: ['CSCA67H3', 'MATA31H3'] }],
    },
    ['Test Program'],
    { completedCourses: [], semesters: 1 }
  );

  const codes = plan.semesters[0]!.courses.map((c) => c.code);
  assert.ok(codes.length > 1, `expected the bounded semester to top up beyond the single required course, got: ${codes.join(', ')}`);
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

test('buildPlanForCourses fills free-elective credit to reach the 20.0-credit degree minimum when semesters is left unset', async () => {
  // "Plan to completion" means finishing the whole degree (UofT's 20.0-credit minimum), not
  // just this one program requirement — so once CSCA08H3 is placed, remaining semesters
  // should keep filling with free-elective credit rather than stopping immediately.
  const plan = await buildPlanForCourses(
    { requiredCourses: ['CSCA08H3'], electiveGroups: [] },
    ['Test Program'],
    { completedCourses: [] } // no semesters given -> plan to completion
  );

  const allCourses = plan.semesters.flatMap((s) => s.courses);
  assert.ok(allCourses.some((c) => c.code === 'CSCA08H3'));
  assert.deepEqual(plan.stillNeeded, []);
  const totalCredits = allCourses.reduce((sum, c) => sum + c.credit, 0);
  assert.equal(totalCredits, 20.0, `expected the plan to fill out to a full 20.0-credit degree, got ${totalCredits}`);
  assert.ok(
    allCourses.some((c) => c.code.startsWith('FREE-ELECTIVE-')),
    'expected free-elective filler once the specific requirement was already satisfied'
  );
});

test('buildPlanForCourses does not add free-elective filler for already-near-complete students', async () => {
  // Simulate a student who already has ~19.5 credits and just needs the one remaining course.
  const priorCredits = Array.from({ length: 39 }, (_, i) => `PLACEHOLDER${i}A01H3`); // 39 x 0.5 = 19.5
  const plan = await buildPlanForCourses(
    { requiredCourses: ['CSCA08H3'], electiveGroups: [] },
    ['Test Program'],
    { completedCourses: priorCredits }
  );

  const allCourses = plan.semesters.flatMap((s) => s.courses);
  assert.ok(allCourses.some((c) => c.code === 'CSCA08H3'));
  // 19.5 completed + 0.5 for CSCA08H3 = 20.0 exactly, so no filler should be needed.
  assert.ok(!allCourses.some((c) => c.code.startsWith('FREE-ELECTIVE-')), `expected no filler, got: ${allCourses.map((c) => c.code).join(', ')}`);
});

test('buildPlanForCourses numbers semesters from the student\'s true position, not always starting at 1', async () => {
  const plan = await buildPlanForCourses({ requiredCourses: ['CSCA08H3'], electiveGroups: [] }, ['Test Program'], {
    completedCourses: [],
    semesters: 1,
    semestersElapsed: 5,
  });

  assert.equal(plan.semesters[0]!.index, 6, `expected the first planned semester to be numbered 6 (5 already elapsed), got ${plan.semesters[0]!.index}`);
});

test('buildPlanForCourses fills free-credit slots with leftover interest-relevant courses instead of generic placeholders', async () => {
  // A "choose 1 of 3" group with only 1 needed leaves 2 legitimate, already-known courses
  // sitting unused. With an interest stated, those should get used as real bonus courses
  // before falling back to a generic "free elective" placeholder.
  const plan = await buildPlanForCourses(
    { requiredCourses: [], electiveGroups: [{ description: 'CS elective', chooseCount: 1, options: ['CSCA08H3', 'CSCA67H3', 'MATA31H3'] }] },
    ['Test Program'],
    { completedCourses: [], interests: 'computer science' } // no semesters given -> plan to completion, where filler applies
  );

  // All 3 known courses have no prereqs and are real/offered, so all 3 should get used as real
  // bonus courses before any generic placeholder shows up (the cap only allows ~1.0 credit of
  // filler beyond them in a single 2.5-credit semester, so some placeholder is still expected
  // once the known pool is exhausted — the point is real courses go first, not that filler
  // never appears at all).
  const semester1 = plan.semesters[0]!.courses;
  const codes = semester1.map((c) => c.code);
  for (const known of ['CSCA08H3', 'CSCA67H3', 'MATA31H3']) {
    assert.ok(codes.includes(known), `expected known course ${known} to be used as a bonus elective, got: ${codes.join(', ')}`);
  }
  const firstPlaceholderIndex = semester1.findIndex((c) => c.code.startsWith('FREE-ELECTIVE-'));
  const lastKnownIndex = Math.max(...['CSCA08H3', 'CSCA67H3', 'MATA31H3'].map((k) => codes.indexOf(k)));
  if (firstPlaceholderIndex !== -1) {
    assert.ok(firstPlaceholderIndex > lastKnownIndex, 'expected known relevant courses to be placed before any generic placeholder');
  }
});

test('buildPlanForCourses rotates across elective groups for interest bonus fill instead of exhausting the first one', async () => {
  // Regression test: bonus filling used to always start scanning from groups[0] on every
  // single bonus slot, so a group with MORE leftover options than there are available slots
  // would monopolize every one of them — a second, smaller group (e.g. the one actually
  // containing a second stated interest) would never get a turn even though it had a real,
  // available option the whole time.
  //
  // MATA37H3 pre-covers the only breadth category these candidate courses share (Quantitative
  // Reasoning), so breadth-fill never fires and both available bonus slots this semester go
  // through the interest branch — isolating the round-robin behavior being tested. 37
  // placeholder credits + MATA37H3 = 19.0 completed, leaving exactly a 1.0-credit (2-slot) gap
  // to the 20.0-credit degree target.
  const priorCredits = [...Array.from({ length: 37 }, (_, i) => `PLACEHOLDER${i}A01H3`), 'MATA37H3'];
  const plan = await buildPlanForCourses(
    {
      requiredCourses: [],
      electiveGroups: [
        { description: 'Group A (big)', chooseCount: 0, options: ['CSCA08H3', 'CSCA67H3', 'MATA31H3'] },
        { description: 'Group B (small)', chooseCount: 0, options: ['MATA30H3'] },
      ],
    },
    ['Test Program'],
    { completedCourses: priorCredits, interests: 'computer science and mathematics' } // no semesters given -> plan to completion
  );

  const codes = plan.semesters.flatMap((s) => s.courses.map((c) => c.code));
  assert.ok(codes.includes('MATA30H3'), `expected group B's option to get a turn via round-robin bonus fill, got: ${codes.join(', ')}`);
});

test('buildPlanForCourses gives co-op work-term courses zero credit weight', async () => {
  // COPB50H3 (Co-op Preparation) is a real UofT course that, per program policy, carries no
  // credit weight — it shouldn't count toward the 20.0-credit degree total.
  const plan = await buildPlanForCourses({ requiredCourses: ['COPB50H3'], electiveGroups: [] }, ['Test Program'], {
    completedCourses: [],
    semesters: 1,
  });

  const placed = plan.semesters[0]?.courses.find((c) => c.code === 'COPB50H3');
  assert.ok(placed, `expected COPB50H3 to be placed, warnings: ${plan.warnings.join('; ')}`);
  assert.equal(placed!.credit, 0, 'expected a co-op course to carry 0 credit weight');
});

test('buildPlanForCourses treats an elective group as "choose N", not "take all"', async () => {
  const plan = await buildPlanForCourses(
    { requiredCourses: [], electiveGroups: [{ description: 'Breadth pick', chooseCount: 1, options: ['CSCA08H3', 'CSCA67H3'] }] },
    ['Test Program'],
    { completedCourses: [], semesters: 1 }
  );

  // Both options have no prereqs and are both offered in Fall, so a naive "flatten to
  // required" bug would count both toward the requirement. Only one may be tagged as
  // satisfying the group itself (the other, if a bounded-preview top-up also places it for a
  // realistic course load, must be tagged as bonus credit, not as satisfying this requirement).
  const placed = plan.semesters[0]!.courses.filter((c) => c.code === 'CSCA08H3' || c.code === 'CSCA67H3');
  const satisfyingGroup = placed.filter((c) => c.category === 'elective');
  assert.equal(satisfyingGroup.length, 1, `expected exactly one of these two to satisfy the group, got: ${JSON.stringify(placed)}`);
  assert.deepEqual(plan.electiveGroupsRemaining, []);
});

test('buildPlanForCourses tags each placed course with why it\'s there (required vs swappable elective/breadth/bonus)', async () => {
  const plan = await buildPlanForCourses(
    { requiredCourses: ['CSCA08H3'], electiveGroups: [{ description: 'Breadth pick', chooseCount: 1, options: ['CSCA67H3', 'MATA31H3'] }] },
    ['Test Program'],
    { completedCourses: [], semesters: 1 }
  );

  const required = plan.semesters[0]!.courses.find((c) => c.code === 'CSCA08H3');
  assert.equal(required?.category, 'required');

  const elective = plan.semesters[0]!.courses.find((c) => c.code === 'CSCA67H3' || c.code === 'MATA31H3');
  assert.equal(elective?.category, 'elective', `expected the elective-group pick to be tagged 'elective', got: ${JSON.stringify(plan.semesters[0]!.courses)}`);
});
