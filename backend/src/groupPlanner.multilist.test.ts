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

// The exact real transcripts from temps/multilist.txt that surfaced a genuine planner bug:
// Marcus took MATA30H3 (Calc I for Physical Sciences) instead of MATA31H3 (Calc I for
// Mathematical Sciences) — a real UofT trap, since they look interchangeable but aren't. His
// CS Comprehensive Specialist requires MATA37H3, which needs MATA31H3 specifically; with no
// path to ever satisfy that, MATA37H3 (and everything chained off it — MATB41H3, CSCC37H3,
// CSCD37H3, CSCC73H3, STAB52H3) sat permanently "unreachable" while the planner kept burying
// that fact under semester after semester of generic "matches your interest" filler instead of
// prioritizing the missing core requirement. Yun-Seo hit the same shape of bug via STAB57H3, a
// prerequisite her transcript doesn't show and that isn't itself a listed requirement/elective.
// Slow (parses 3 real transcripts + builds 3 real plans with live Steel lookups) — run
// standalone with `npx tsx --test src/groupPlanner.multilist.test.ts` during iteration rather
// than the full `npm test`.

const CS_SWE_COOP_PROGRAM: ProgramSelector = { campus: 'utsc', sectionSlug: 'Computer-Science', programCode: 'SCSPE0795C' }; // Specialist (Co-op), Software Engineering Stream
const CS_COMPREHENSIVE_PROGRAM: ProgramSelector = { campus: 'utsc', sectionSlug: 'Computer-Science', programCode: 'SCSPE0510' }; // Specialist, Comprehensive Stream
const STATS_MLDS_PROGRAM: ProgramSelector = { campus: 'utsc', sectionSlug: 'Statistics', programCode: 'SCSPE2289Z' }; // Specialist, Statistical Machine Learning and Data Science Stream

const PRIYA_TRANSCRIPT = `UNIVERSITY OF TORONTO SCARBOROUGH
Academic History — Unofficial Transcript

Student: Priya Nadarajah
Program: Software Engineering Specialist (Co-op)

Session: 2025 Fall
CSCA08H3   Introduction to Computer Science I         85   A     0.5
MATA22H3   Linear Algebra I                            74   B     0.5
MATA31H3   Calculus I for Mathematical Sciences         71   B-    0.5
PHYA10H3   Physics I                                    79   B+    0.5
Sessional GPA: 3.30                                    Credits: 2.0

Session: 2026 Winter
CSCA48H3   Introduction to Computer Science II          88   A     0.5
MATA23H3   Linear Algebra II                             69   C+    0.5
PHYA21H3   Physics II                                    75   B     0.5
WRTA02H3   Effective Writing About Science               81   A-    0.5
Sessional GPA: 3.28                                    Credits: 2.0

Cumulative GPA: 3.29                                  Total Credits: 4.0
Standing: Good Standing — Continuing into Year 2`;

// Marcus took MATA30H3 (Calc I for PHYSICAL sciences), not MATA31H3 (Calc I for MATHEMATICAL
// sciences) — these are NOT interchangeable, and his program's required MATA37H3 needs MATA31H3
// specifically. This is the transcript detail that used to permanently strand his plan.
const MARCUS_TRANSCRIPT = `UNIVERSITY OF TORONTO SCARBOROUGH
Academic History — Unofficial Transcript

Student: Marcus Oduya
Program: Computer Science Comprehensive

Session: 2025 Fall
CSCA08H3   Introduction to Computer Science I          79   B+    0.5
MATA22H3   Linear Algebra I                             68   C+    0.5
MATA30H3   Calculus I for Physical Sciences              73   B-    0.5
PHLA10H3   Introduction to Philosophy                     84   A     0.5
Sessional GPA: 3.05                                    Credits: 2.0

Session: 2026 Winter
CSCA48H3   Introduction to Computer Science II           82   A-    0.5
MATA23H3   Linear Algebra II                              70   B-    0.5
HISB31H3   History of Modern Europe                        88   A     0.5
CSCA20H3   Introduction to Programming (elective retake)   91   A+    0.5
Sessional GPA: 3.45                                    Credits: 2.0

Cumulative GPA: 3.25                                  Total Credits: 4.0
Standing: Good Standing — Continuing into Year 2`;

const YUNSEO_TRANSCRIPT = `UNIVERSITY OF TORONTO SCARBOROUGH
Academic History — Unofficial Transcript

Student: Yun-Seo Park
Program: Statistics Specialist — Machine Learning & Data Science

Session: 2025 Fall
CSCA08H3   Introduction to Computer Science I          91   A+    0.5
MATA22H3   Linear Algebra I                             86   A     0.5
MATA31H3   Calculus I for Mathematical Sciences          80   A-    0.5
STAB22H3   Statistics I                                   89   A     0.5
Sessional GPA: 3.87                                    Credits: 2.0

Session: 2026 Winter
CSCA48H3   Introduction to Computer Science II           93   A+    0.5
MATA23H3   Linear Algebra II                              83   A-    0.5
STAB23H3   Statistics II                                   90   A+    0.5
MATA37H3   Calculus II for Mathematical Sciences            77   B+    0.5
Sessional GPA: 3.83                                    Credits: 2.0

Cumulative GPA: 3.85                                  Total Credits: 4.0
Standing: Good Standing — Continuing into Year 2 (Dean's List)`;

test('buildGroupPlan does not get permanently stuck when a student is missing a transitive (non-required) prerequisite', async () => {
  const [priya, marcus, yunSeo] = await Promise.all([
    parseTranscript(PRIYA_TRANSCRIPT, 'robotics and cybersecurity'),
    parseTranscript(MARCUS_TRANSCRIPT, 'cybersecurity and encryption, not robotics'),
    parseTranscript(YUNSEO_TRANSCRIPT, 'machine learning and embedded systems'),
  ]);

  const groupPlan = await buildGroupPlan({
    friends: [
      {
        name: 'Priya',
        completedCourses: priya.completedCourses,
        inProgressCourses: priya.inProgressCourses,
        programs: [CS_SWE_COOP_PROGRAM],
        semestersElapsed: priya.semestersElapsed,
        startSession: priya.nextSession,
        interests: 'robotics and cybersecurity',
      },
      {
        name: 'Marcus',
        completedCourses: marcus.completedCourses,
        inProgressCourses: marcus.inProgressCourses,
        programs: [CS_COMPREHENSIVE_PROGRAM],
        semestersElapsed: marcus.semestersElapsed,
        startSession: marcus.nextSession,
        interests: 'cybersecurity and encryption, not robotics',
      },
      {
        name: 'Yun-Seo',
        completedCourses: yunSeo.completedCourses,
        inProgressCourses: yunSeo.inProgressCourses,
        programs: [STATS_MLDS_PROGRAM],
        semestersElapsed: yunSeo.semestersElapsed,
        startSession: yunSeo.nextSession,
        interests: 'machine learning and embedded systems',
      },
    ],
    constraintsPrompt: 'We would like as much overlap as possible this summer and fall, and at least one class together for as long as possible.',
  });
  writeTestOutput('groupPlanner-multilist', groupPlan);

  const priyaPlan = groupPlan.friends.find((f) => f.name === 'Priya')!.plan;
  const marcusPlan = groupPlan.friends.find((f) => f.name === 'Marcus')!.plan;
  const yunSeoPlan = groupPlan.friends.find((f) => f.name === 'Yun-Seo')!.plan;

  // The core regression: none of the three plans should report getting permanently stuck.
  // Priya's co-op program surfaced a related bug the same way: COPC0X work-term "courses"
  // never appear in a live TTB search (they're registered through the co-op office, not the
  // normal timetable), so treating that the same as "discontinued" would strand her plan too.
  for (const [name, plan] of [
    ['Priya', priyaPlan],
    ['Marcus', marcusPlan],
    ['Yun-Seo', yunSeoPlan],
  ] as const) {
    assert.ok(
      !plan.warnings.some((w) => w.includes('Stopped early')),
      `expected ${name}'s plan not to get permanently stuck, warnings: ${plan.warnings.join('; ')}`
    );
  }

  // Marcus's plan should recognize and schedule the actual missing prerequisite (MATA31H3),
  // not just stay silently blocked on MATA37H3 forever.
  const marcusCodes = marcusPlan.semesters.flatMap((s) => s.courses.map((c) => c.code));
  assert.ok(marcusCodes.includes('MATA31H3'), `expected MATA31H3 to be scheduled in Marcus's plan despite his MATA30H3/MATA31H3 exclusion, got: ${marcusCodes.join(', ')}`);

  // With the prerequisite chain unblocked, the courses that were permanently stuck before
  // should now actually get scheduled rather than sitting in "still needed" forever.
  for (const code of ['MATA37H3', 'STAB52H3']) {
    assert.ok(marcusCodes.includes(code), `expected ${code} to become reachable once MATA31H3 was added, got: ${marcusCodes.join(', ')}`);
  }

  // Priya's co-op prep courses should get scheduled despite never appearing in a live TTB search.
  const priyaCodes = priyaPlan.semesters.flatMap((s) => s.courses.map((c) => c.code));
  assert.ok(
    priyaCodes.some((c) => /^COPB5[0-9]H3$/.test(c)),
    `expected at least one co-op prep course to be scheduled for Priya despite having no TTB offerings, got: ${priyaCodes.join(', ')}`
  );
});
