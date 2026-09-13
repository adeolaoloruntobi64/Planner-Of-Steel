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

test('buildPlanForCourses shows summer terms as an explicit, non-counted break by default', async () => {
  // UofT's academic year is really 3 terms (Fall/Winter/Summer), not 2 — a summer term should
  // still appear in the output as a visible placeholder (so a student knows it exists and how
  // to opt into it) even when it's not being used for courses, and it shouldn't eat into a
  // bounded "plan the next N semesters" request.
  const plan = await buildPlanForCourses(
    { requiredCourses: ['CSCA08H3', 'CSCA48H3'], electiveGroups: [] },
    ['Test Program'],
    { completedCourses: [], semesters: 3, startSession: 'S' }
  );

  const breaks = plan.semesters.filter((s) => s.type === 'break');
  assert.ok(
    breaks.length > 0,
    `expected at least one summer break in the plan, got: ${plan.semesters.map((s) => `${s.session}(${s.type})`).join(', ')}`
  );
  for (const b of breaks) {
    assert.equal(b.session, 'SU');
    assert.deepEqual(b.courses, []);
  }

  // Breaks don't count against the bound — at most 3 REAL semesters should ever appear (fewer
  // is fine too, since the loop already stops as soon as nothing is left to schedule).
  const realSemesters = plan.semesters.filter((s) => s.type !== 'break');
  assert.ok(realSemesters.length <= 3, `expected at most 3 real (non-break) semesters, got ${realSemesters.length}`);
});

test('buildPlanForCourses schedules real courses in summer when includeSummers is enabled', async () => {
  const plan = await buildPlanForCourses(
    { requiredCourses: ['CSCA08H3', 'CSCA48H3'], electiveGroups: [] },
    ['Test Program'],
    { completedCourses: [], semesters: 3, startSession: 'S', includeSummers: true }
  );

  assert.ok(
    !plan.semesters.some((s) => s.type === 'break'),
    `expected no break semesters when includeSummers is on, got: ${plan.semesters.map((s) => `${s.session}(${s.type})`).join(', ')}`
  );
  assert.ok(plan.semesters.some((s) => s.session === 'SU'), 'expected at least one real summer semester to be scheduled');
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

test('buildPlanForCourses caps the course load during a work-term semester instead of stacking a full load alongside it', async () => {
  // A student on a full-time co-op work term isn't also carrying a normal 2.5-credit/5-course
  // load — realistically at most one course. COPC01H3's own real prerequisite is satisfied
  // directly via a completed alternative, so it's reachable in semester 1 alongside 3 other
  // real, prereq-free required courses that would otherwise all get crammed in too.
  const plan = await buildPlanForCourses(
    { requiredCourses: ['COPC01H3', 'CSCA08H3', 'CSCA67H3', 'MATA31H3'], electiveGroups: [] },
    ['Test Program'],
    { completedCourses: ['COPB57H3'], semesters: 1 }
  );

  const semester1 = plan.semesters[0]!;
  assert.equal(semester1.type, 'work', `expected semester 1 to be recognized as a work term, got type: ${semester1.type}`);
  const realCourseCredits = semester1.courses.reduce((sum, c) => sum + c.credit, 0);
  assert.ok(
    realCourseCredits <= 0.5,
    `expected at most 0.5 credit of real courses alongside a work term, got ${realCourseCredits} (${semester1.courses.map((c) => c.code).join(', ')})`
  );
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

test('buildPlanForCourses never schedules two mutually-exclusive courses together', async () => {
  // STAB52H3 ("An Introduction to Probability") and STAB53H3 ("Introduction to Applied
  // Probability") exclude each other — real UofT data, not a contrived pair. Once STAB52H3 is
  // required and placed, STAB53H3 should never ALSO show up as bonus/interest filler just
  // because nothing had explicitly ruled it out yet.
  const plan = await buildPlanForCourses(
    {
      requiredCourses: ['STAB52H3'],
      electiveGroups: [{ description: 'Stats elective', chooseCount: 0, options: ['STAB53H3'] }],
    },
    ['Test Program'],
    { completedCourses: ['MATA22H3', 'MATA37H3'], interests: 'probability' } // pre-satisfy STAB52H3/STAB53H3's own prereqs
  );

  const codes = plan.semesters.flatMap((s) => s.courses.map((c) => c.code));
  assert.ok(codes.includes('STAB52H3'), `expected the required STAB52H3 to be placed, got: ${codes.join(', ')}`);
  assert.ok(!codes.includes('STAB53H3'), `expected STAB53H3 to never be scheduled alongside its mutual exclusion STAB52H3, got: ${codes.join(', ')}`);
});

test('buildPlanForCourses treats a required course satisfied by an already-placed mutual exclusion, not stuck forever', async () => {
  // MATA22H3 and MATA23H3 (two "Linear Algebra I" variants) exclude each other. If both somehow
  // ended up unconditionally required (e.g. from a messy scrape), placing one should satisfy
  // the other via equivalence rather than leaving it permanently stuck in "still needed".
  const plan = await buildPlanForCourses(
    { requiredCourses: ['MATA22H3', 'MATA23H3'], electiveGroups: [] },
    ['Test Program'],
    { completedCourses: ['CSCA67H3'] } // satisfies MATA22H3's own prereq
  );

  assert.deepEqual(plan.stillNeeded, []);
  assert.ok(
    !plan.warnings.some((w) => w.includes('Stopped early')),
    `expected no "stuck" warning, got: ${plan.warnings.join('; ')}`
  );
  const codes = plan.semesters.flatMap((s) => s.courses.map((c) => c.code));
  assert.ok(codes.includes('MATA22H3') !== codes.includes('MATA23H3'), `expected exactly one of the two to actually be scheduled, got: ${codes.join(', ')}`);
});

test('buildPlanForCourses does not let a "no credit for the earlier one" exclusion block a genuine prerequisite chain', async () => {
  // COPC02H3 (Arts and Science Co-op Work Term 2) REQUIRES COPC01H3 (Work Term 1) as a
  // prerequisite, yet COPC02H3's calendar entry also lists COPC01H3 in its "excludes" — UofT's
  // way of saying "no separate credit for the earlier work term", not "can't have both". These
  // two must still both get scheduled, in sequence, rather than being treated as alternatives.
  const plan = await buildPlanForCourses({ requiredCourses: ['COPC01H3', 'COPC02H3'], electiveGroups: [] }, ['Test Program'], { completedCourses: [] });

  const codes = plan.semesters.flatMap((s) => s.courses.map((c) => c.code));
  assert.ok(codes.includes('COPC01H3'), `expected COPC01H3 to be scheduled, got: ${codes.join(', ')}`);
  assert.ok(codes.includes('COPC02H3'), `expected COPC02H3 to also be scheduled (not blocked by its own prerequisite appearing in its exclusion list), got: ${codes.join(', ')}`);
  assert.deepEqual(plan.stillNeeded, []);
});

test('buildPlanForCourses does not schedule a credit-count-gated course before the student has enough credits', async () => {
  // CSCD03H3's entire prerequisite is "14.0 credits and enrolment in a Computer Science Subject
  // POSt" — no course code at all. A first-year student with 0 completed credits should never
  // see it in semester 1; it should wait until enough credit has actually accumulated.
  const plan = await buildPlanForCourses({ requiredCourses: ['CSCA08H3', 'CSCD03H3'], electiveGroups: [] }, ['Test Program'], { completedCourses: [] });

  const semester1Codes = plan.semesters[0]!.courses.map((c) => c.code);
  assert.ok(!semester1Codes.includes('CSCD03H3'), `expected CSCD03H3 not to be scheduled in semester 1 with 0 credits, got: ${semester1Codes.join(', ')}`);
});

test('buildPlanForCourses waits for an elective group\'s top-ranked option to become reachable instead of settling for the first reachable one', async () => {
  // CSCA48H3 needs CSCA08H3 first; MATA31H3 has no prerequisite at all and would be reachable
  // immediately. With an interest naming CSCA48H3 specifically (ranking it top), the group
  // should hold off filling its one slot with the always-available MATA31H3 and wait for
  // CSCA48H3 to become reachable instead — not silently settle for whatever's available first.
  const plan = await buildPlanForCourses(
    { requiredCourses: ['CSCA08H3'], electiveGroups: [{ description: 'Elective', chooseCount: 1, options: ['CSCA48H3', 'MATA31H3'] }] },
    ['Test Program'],
    { completedCourses: [], semesters: 2, interests: 'I want CSCA48H3 specifically' }
  );

  const electivePick = plan.semesters.flatMap((s) => s.courses).find((c) => c.category === 'elective');
  assert.equal(electivePick?.code, 'CSCA48H3', `expected the group to wait for CSCA48H3 rather than settling for MATA31H3 immediately, got: ${electivePick?.code}`);
});

test('buildPlanForCourses prioritizes an explicitly-named course in interests over other bonus filler', async () => {
  // A student naming a specific real course (not just a theme like "cybersecurity") is a much
  // stronger signal — it should get first priority for bonus/interest filling every semester,
  // waiting for its own prerequisite (CSCA08H3) rather than a generic filler course
  // permanently taking that credit slot first.
  const plan = await buildPlanForCourses(
    { requiredCourses: ['CSCA08H3'], electiveGroups: [{ description: 'Elective', chooseCount: 0, options: ['CSCA48H3', 'MATA31H3'] }] },
    ['Test Program'],
    { completedCourses: [], interests: 'I specifically want CSCA48H3' } // no semesters given -> plan to completion
  );

  const allCourses = plan.semesters.flatMap((s) => s.courses);
  const cscA48Semester = plan.semesters.find((s) => s.courses.some((c) => c.code === 'CSCA48H3'));
  const cscA08Semester = plan.semesters.find((s) => s.courses.some((c) => c.code === 'CSCA08H3'));
  assert.ok(cscA48Semester, `expected CSCA48H3 to eventually be scheduled, got: ${allCourses.map((c) => c.code).join(', ')}`);
  assert.ok(cscA08Semester, 'expected CSCA08H3 (a required course) to be scheduled');
  assert.ok(cscA48Semester!.index > cscA08Semester!.index, `expected CSCA48H3 (semester ${cscA48Semester!.index}) after its own prerequisite CSCA08H3 (semester ${cscA08Semester!.index})`);
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
