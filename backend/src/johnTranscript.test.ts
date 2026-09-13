import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import { parseTranscript } from './transcript';
import { buildPlan } from './planner';
import { closeSteelPool } from './courses/steelPool';
import { writeTestOutput } from './testSupport';

dotenv.config();
after(() => closeSteelPool());

// The exact real transcript from temps/list.txt (John Doe, 2nd year CS, UTSC) that surfaced
// several real bugs during manual testing (prereq AND/OR parsing, transient-error handling,
// the tab-reuse race condition). Kept as a fixture here so those scenarios stay covered.
// Slow (~30-70s per case, 5 cases) — run standalone during iteration with
// `npx tsx --test src/johnTranscript.test.ts` rather than the full `npm test`.
const JOHN_TRANSCRIPT = `UNIVERSITY OF TORONTO SCARBOROUGH
UNOFFICIAL ACADEMIC TRANSCRIPT

STUDENT INFORMATION:
Student Name: Doe, John
Student Number: 1008542190
Admission Category: Computer Science (Year 1)
Program of Study: Major in Computer Science (POSt: Active)
Current Session: Fall/Winter 2026-2027

SESSION: FALL 2025 (20259)
CSCA08H3 Introduction to Computer Science I — Grade: A-
MATA31H3 Calculus I for Mathematical Sciences — Grade: B
MATA22H3 Linear Algebra I for Mathematical Sciences — Grade: B+
ENGA10H3 Introduction to English Literature — Grade: A
PHLA10H3 Reason and Truth — Grade: A-
Session GPA: 3.63 | Session Credits: 2.50

SESSION: WINTER 2026 (20261)
CSCA48H3 Introduction to Computer Science II — Grade: A
CSCA67H3 Discrete Mathematics — Grade: B+
MATA37H3 Calculus II for Mathematical Sciences — Grade: B-
LINA01H3 Introduction to Linguistics — Grade: A-
MGTA01H3 Introduction to Business — Grade: A
Session GPA: 3.56 | Session Credits: 2.50
Cumulative GPA: 3.60 | Total Credits Earned: 5.00

SESSION: SUMMER 2026 (20265)
CSCB07H3 Software Design — Grade: A-
STAB52H3 Introduction to Probability — Grade: B+
MADA01H3 Intro to Digital Humanities — Grade: A
ANTA01H3 Introduction to Anthropology: Society, Culture, and Language — Grade: A-
HLTA02H3 Foundations of Epidemiology — Grade: B+
Session GPA: 3.65 | Session Credits: 2.50
Cumulative GPA: 3.62 | Total Credits Earned: 7.50

SESSION: FALL/WINTER 2026-2027 (20269-20271) — In Progress
CSCB09H3 Software Tools and Systems Programming — Status: IPR
CSCB36H3 Introduction to the Theory of Computation — Status: IPR
CSCB58H3 Computer Organization — Status: IPR
CSCB63H3 Design and Analysis of Data Structures — Status: IPR
MATB24H3 Linear Algebra II — Status: IPR
COPB50H3 Co-op Preparation — Status: IPR
EESA01H3 Introduction to Environmental Science — Status: IPR
Session Credits In Progress: 3.50

TRANSCRIPT TOTALS TO DATE:
Total Credits Earned: 7.50
Cumulative Grade Point Average (CGPA): 3.62
Standing Status: Good Standing / Program POSt Complete`;

const PROGRAM = { campus: 'utsc' as const, sectionSlug: 'Computer-Science', programCode: 'SCSPE0510' }; // Specialist, Comprehensive Stream

// A course genuinely worth checking is an ELECTIVE option (not one of the program's
// unconditionally-required courses), so the presence check actually exercises interest-based
// ranking rather than something that would show up regardless.
const SCENARIOS: { label: string; prompt: string; expectCode?: string; expectTitleMatch?: RegExp }[] = [
  { label: 'cybersecurity', prompt: "I'm looking to go into cybersecurity", expectCode: 'CSCD27H3', expectTitleMatch: /security/i },
  { label: 'robotics', prompt: "I'm interested in robotics", expectCode: 'CSCC85H3', expectTitleMatch: /robotics/i },
  { label: 'web development', prompt: 'I want to get into web development', expectCode: 'CSCC09H3', expectTitleMatch: /web/i },
  { label: 'databases', prompt: 'I want to specialize in databases', expectCode: 'CSCD43H3', expectTitleMatch: /database/i },
  { label: 'nothing specified (all-rounder)', prompt: '' },
];

for (const scenario of SCENARIOS) {
  test(`John's transcript with interest "${scenario.label}" produces a coherent plan`, async () => {
    const parsed = await parseTranscript(JOHN_TRANSCRIPT, scenario.prompt || undefined);
    const plan = await buildPlan({
      completedCourses: parsed.completedCourses,
      inProgressCourses: parsed.inProgressCourses,
      programs: [PROGRAM],
      semestersElapsed: parsed.semestersElapsed,
      startSession: parsed.nextSession,
      ...(scenario.prompt && { interests: scenario.prompt }),
    });
    writeTestOutput(`johnTranscript-${scenario.label}`, { interest: scenario.prompt || null, parsed, plan });

    // Basic sanity: the plan produced real semesters and isn't obviously broken.
    assert.ok(plan.semesters.length > 0, `expected at least one planned semester, warnings: ${plan.warnings.join('; ')}`);
    assert.ok(plan.programs[0]?.includes('COMPUTER SCIENCE'));

    if (scenario.expectCode) {
      const allCourses = plan.semesters.flatMap((s) => s.courses);
      const match = allCourses.find((c) => c.code === scenario.expectCode);
      // Not a hard requirement (the course could legitimately be unavailable this term, or
      // already satisfied some other way) — but if it's missing, at least confirm the plan
      // didn't silently ignore the interest signal by checking no course with a title matching
      // the theme appears either, so a genuine ranking regression would still be caught.
      if (!match) {
        const anyThemed = allCourses.find((c) => scenario.expectTitleMatch!.test(c.title));
        assert.ok(
          anyThemed,
          `expected either ${scenario.expectCode} or some course matching /${scenario.expectTitleMatch}/ for interest "${scenario.label}", got: ${allCourses.map((c) => c.code).join(', ')}`
        );
      }
    }
  });
}
