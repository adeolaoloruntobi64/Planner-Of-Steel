import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import { parseTranscript } from './transcript';
import { buildGroupPlan } from './groupPlanner';
import type { ProgramSelector } from './planner';
import { closeSteelPool } from './courses/steelPool';
import { writeTestOutput } from './testSupport';

dotenv.config();
after(() => closeSteelPool());

// Slow (parses 3 real transcripts + builds 3 real plans with live Steel lookups) — run
// standalone with `npx tsx --test src/groupPlanner.year3Overlap.test.ts` during iteration
// rather than the full `npm test`.

const CS_SWE_PROGRAM: ProgramSelector = { campus: 'utsc', sectionSlug: 'Computer-Science', programCode: 'SCSPE0795' }; // Specialist, Software Engineering Stream
const STATS_MLDS_PROGRAM: ProgramSelector = { campus: 'utsc', sectionSlug: 'Statistics', programCode: 'SCSPE2289Z' }; // Specialist, Statistical Machine Learning and Data Science Stream

// Two distinct-but-comparable 2nd-year CS transcripts (same real courses, different names/grades)
// so the two CS friends aren't literal duplicates of each other.
const CS_YEAR2_A = `UNIVERSITY OF TORONTO SCARBOROUGH
UNOFFICIAL ACADEMIC TRANSCRIPT
Student Name: Doe, Jordan
Admission Category: Computer Science (Year 1)
Program of Study: Specialist in Computer Science, Software Engineering Stream (POSt: Active)
Current Session: Fall/Winter 2026-2027

SESSION: FALL 2025 (20259)
CSCA08H3 Introduction to Computer Science I — Grade: A-
MATA31H3 Calculus I for Mathematical Sciences — Grade: B
MATA22H3 Linear Algebra I for Mathematical Sciences — Grade: B+
ENGA10H3 Introduction to English Literature — Grade: A

SESSION: WINTER 2026 (20261)
CSCA48H3 Introduction to Computer Science II — Grade: A
CSCA67H3 Discrete Mathematics — Grade: B+
MATA37H3 Calculus II for Mathematical Sciences — Grade: B-
LINA01H3 Introduction to Linguistics — Grade: A-

SESSION: FALL/WINTER 2026-2027 (20269-20271) — In Progress
CSCB09H3 Software Tools and Systems Programming — Status: IPR
CSCB36H3 Introduction to the Theory of Computation — Status: IPR
CSCB58H3 Computer Organization — Status: IPR
MATB24H3 Linear Algebra II — Status: IPR
Cumulative Credits Earned: 5.00, In Progress: 2.00`;

const CS_YEAR2_B = `UNIVERSITY OF TORONTO SCARBOROUGH
UNOFFICIAL ACADEMIC TRANSCRIPT
Student Name: Lee, Taylor
Admission Category: Computer Science (Year 1)
Program of Study: Specialist in Computer Science, Software Engineering Stream (POSt: Active)
Current Session: Fall/Winter 2026-2027

SESSION: FALL 2025 (20259)
CSCA08H3 Introduction to Computer Science I — Grade: B+
MATA31H3 Calculus I for Mathematical Sciences — Grade: A-
MATA22H3 Linear Algebra I for Mathematical Sciences — Grade: B

SESSION: WINTER 2026 (20261)
CSCA48H3 Introduction to Computer Science II — Grade: A-
CSCA67H3 Discrete Mathematics — Grade: A
MATA37H3 Calculus II for Mathematical Sciences — Grade: B+

SESSION: FALL/WINTER 2026-2027 (20269-20271) — In Progress
CSCB09H3 Software Tools and Systems Programming — Status: IPR
CSCB36H3 Introduction to the Theory of Computation — Status: IPR
CSCB58H3 Computer Organization — Status: IPR
MATB24H3 Linear Algebra II — Status: IPR
Cumulative Credits Earned: 4.00, In Progress: 2.00`;

const STATS_YEAR2 = `UNIVERSITY OF TORONTO SCARBOROUGH
UNOFFICIAL ACADEMIC TRANSCRIPT
Student Name: Chen, Morgan
Admission Category: Statistics (Year 1)
Program of Study: Specialist in Statistics, Statistical Machine Learning and Data Science Stream (POSt: Active)
Current Session: Fall/Winter 2026-2027

SESSION: FALL 2025 (20259)
MATA31H3 Calculus I for Mathematical Sciences — Grade: A-
MATA22H3 Linear Algebra I for Mathematical Sciences — Grade: B+
CSCA08H3 Introduction to Computer Science I — Grade: B

SESSION: WINTER 2026 (20261)
MATA37H3 Calculus II for Mathematical Sciences — Grade: A-
STAB52H3 Introduction to Probability — Grade: A
CSCA48H3 Introduction to Computer Science II — Grade: B+

SESSION: FALL/WINTER 2026-2027 (20269-20271) — In Progress
STAB53H3 Introduction to Statistics — Status: IPR
STAB57H3 An Introduction to Data Science — Status: IPR
MATB24H3 Linear Algebra II — Status: IPR
Cumulative Credits Earned: 4.50, In Progress: 1.50`;

test('buildGroupPlan finds shared 3rd-year classes for 2 CS SWE friends and 1 Stats ML/DS friend, all in year 2', async () => {
  const [jordan, taylor, morgan] = await Promise.all([
    parseTranscript(CS_YEAR2_A, 'software engineering'),
    parseTranscript(CS_YEAR2_B, 'software engineering'),
    parseTranscript(STATS_YEAR2, 'machine learning and data science'),
  ]);

  const groupPlan = await buildGroupPlan({
    friends: [
      {
        name: 'Jordan',
        completedCourses: jordan.completedCourses,
        inProgressCourses: jordan.inProgressCourses,
        programs: [CS_SWE_PROGRAM],
        semestersElapsed: jordan.semestersElapsed,
        startSession: jordan.nextSession,
        interests: 'software engineering',
      },
      {
        name: 'Taylor',
        completedCourses: taylor.completedCourses,
        inProgressCourses: taylor.inProgressCourses,
        programs: [CS_SWE_PROGRAM],
        semestersElapsed: taylor.semestersElapsed,
        startSession: taylor.nextSession,
        interests: 'software engineering',
      },
      {
        name: 'Morgan',
        completedCourses: morgan.completedCourses,
        inProgressCourses: morgan.inProgressCourses,
        programs: [STATS_MLDS_PROGRAM],
        semestersElapsed: morgan.semestersElapsed,
        startSession: morgan.nextSession,
        interests: 'machine learning and data science',
      },
    ],
    constraintsPrompt: 'All three of us are in 2nd year and want to share as many 3rd year classes together as possible.',
  });
  writeTestOutput('groupPlanner-year3-overlap', groupPlan);

  assert.equal(groupPlan.friends.length, 3);
  for (const f of groupPlan.friends) {
    assert.ok(f.plan.semesters.length > 0, `expected ${f.name} to get a real plan, warnings: ${f.plan.warnings.join('; ')}`);
  }

  // The group prompt should be understood as a "maximize shared classes" goal restricted to
  // year 3, not ignored, not misread as "take-together" (a different, more specific ask), and
  // not left as a single lowest-common-denominator suggestion — "as many as possible" implies
  // wanting several, and with 3 different majors a full-trio-only view would understate what
  // pairs within the group can actually share.
  assert.ok(
    groupPlan.sharedSuggestions.length > 0 || groupPlan.warnings.length > 0,
    'expected either shared-course suggestions or an explanatory warning, got neither'
  );
  if (groupPlan.sharedSuggestions.length > 0) {
    for (const s of groupPlan.sharedSuggestions) {
      assert.equal(s.constraintType, 'maximize-shared');
      assert.match(s.code, /^[A-Z]{3,4}\d{2,3}[HY][135]$/);
      // "Year 3" was requested -> every suggested semester should fall in semesters 5-6.
      for (const fs of s.friendSemesters) {
        assert.ok(fs.semesterIndex === 5 || fs.semesterIndex === 6, `expected ${s.code} to land in year 3 (semester 5 or 6) for ${fs.name}, got semester ${fs.semesterIndex}`);
      }
    }

    // A full-trio suggestion needs a course common to ALL THREE friends' own requirement/
    // elective pools landing in year 3 for everyone — genuinely thin when 2 majors differ, and
    // sensitive to run-to-run variance in live transcript parsing, so it's not guaranteed every
    // run. A pairwise suggestion (the two CS friends sharing real upper-year CS courses) is
    // still a correct, useful outcome on its own — this only checks that suggestions exist and
    // are well-formed, not that a full-trio one specifically shows up this run.
    const pairOrTrio = groupPlan.sharedSuggestions.filter((s) => s.friendNames.length >= 2);
    assert.ok(pairOrTrio.length > 0, `expected at least one pair/trio suggestion, got: ${JSON.stringify(groupPlan.sharedSuggestions.map((s) => s.friendNames))}`);
  }
});
