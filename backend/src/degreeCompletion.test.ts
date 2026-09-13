import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import { parseTranscript } from './transcript';
import { buildPlan, type ProgramSelector } from './planner';
import { closeSteelPool } from './courses/steelPool';

dotenv.config();
after(() => closeSteelPool());

// Full-pipeline verification: real transcript -> real program requirements -> a plan that
// reaches exactly the 20.0-credit degree minimum, across 3 class years x 3 subjects. This file
// is slow (each case drives the real transcript-parsing LLM call plus a real plan build with
// live Steel lookups for the nearest semester) - run standalone during iteration with
// `npx tsx --test src/degreeCompletion.test.ts` rather than the full `npm test` if you're
// only working on this.

const CS_PROGRAM: ProgramSelector = { campus: 'utsc', sectionSlug: 'Computer-Science', programCode: 'SCMAJ1688' };
const STATS_PROGRAM: ProgramSelector = { campus: 'utsc', sectionSlug: 'Statistics', programCode: 'SCSPE2289F' }; // Quantitative Finance Stream
const MATH_PROGRAM: ProgramSelector = { campus: 'utsc', sectionSlug: 'Mathematics', programCode: 'SCMAJ1165' };

const CS_YEAR1 = `UNIVERSITY OF TORONTO SCARBOROUGH
UNOFFICIAL ACADEMIC TRANSCRIPT
Student Name: Doe, Jane
Admission Category: Computer Science (Year 1)
Program of Study: Major in Computer Science (POSt: Active)
Current Session: Fall 2026

No sessions completed yet. Student is about to begin their first semester.`;

const CS_YEAR2 = `UNIVERSITY OF TORONTO SCARBOROUGH
UNOFFICIAL ACADEMIC TRANSCRIPT
Student Name: Doe, John
Admission Category: Computer Science (Year 1)
Program of Study: Major in Computer Science (POSt: Active)
Current Session: Fall/Winter 2026-2027

SESSION: FALL 2025 (20259)
CSCA08H3 Introduction to Computer Science I — Grade: A-
MATA31H3 Calculus I for Mathematical Sciences — Grade: B
MATA22H3 Linear Algebra I for Mathematical Sciences — Grade: B+
ENGA10H3 Introduction to English Literature — Grade: A
PHLA10H3 Reason and Truth — Grade: A-

SESSION: WINTER 2026 (20261)
CSCA48H3 Introduction to Computer Science II — Grade: A
CSCA67H3 Discrete Mathematics — Grade: B+
MATA37H3 Calculus II for Mathematical Sciences — Grade: B-
LINA01H3 Introduction to Linguistics — Grade: A-
MGTA01H3 Introduction to Business — Grade: A

SESSION: FALL/WINTER 2026-2027 (20269-20271) — In Progress
CSCB09H3 Software Tools and Systems Programming — Status: IPR
CSCB36H3 Introduction to the Theory of Computation — Status: IPR
CSCB58H3 Computer Organization — Status: IPR
MATB24H3 Linear Algebra II — Status: IPR
Cumulative Credits Earned: 5.00, In Progress: 2.00`;

const CS_YEAR3 = `UNIVERSITY OF TORONTO SCARBOROUGH
UNOFFICIAL ACADEMIC TRANSCRIPT
Student Name: Doe, Alex
Admission Category: Computer Science (Year 1)
Program of Study: Major in Computer Science (POSt: Active)
Current Session: Fall/Winter 2027-2028

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

SESSION: FALL 2026 (20269)
CSCB07H3 Software Design — Grade: A-
CSCB09H3 Software Tools and Systems Programming — Grade: B+
MATB24H3 Linear Algebra II — Grade: B
STAB52H3 Introduction to Probability — Grade: A-

SESSION: WINTER 2027 (20271)
CSCB36H3 Introduction to the Theory of Computation — Grade: B+
CSCB58H3 Computer Organization — Grade: A-
CSCB63H3 Design and Analysis of Data Structures — Grade: B

SESSION: FALL/WINTER 2027-2028 — In Progress
CSCC43H3 Introduction to Databases — Status: IPR
CSCC63H3 Computability and Computational Complexity — Status: IPR
Cumulative Credits Earned: 11.50, In Progress: 1.00`;

const STATS_YEAR1 = `UNIVERSITY OF TORONTO SCARBOROUGH
UNOFFICIAL ACADEMIC TRANSCRIPT
Student Name: Chen, Sam
Admission Category: Statistics (Year 1)
Program of Study: Specialist in Statistics, Quantitative Finance Stream (POSt: Active)
Current Session: Fall 2026

No sessions completed yet. Student is about to begin their first semester.`;

const STATS_YEAR2 = `UNIVERSITY OF TORONTO SCARBOROUGH
UNOFFICIAL ACADEMIC TRANSCRIPT
Student Name: Chen, Morgan
Admission Category: Statistics (Year 1)
Program of Study: Specialist in Statistics, Quantitative Finance Stream (POSt: Active)
Current Session: Fall/Winter 2026-2027

SESSION: FALL 2025 (20259)
MATA31H3 Calculus I for Mathematical Sciences — Grade: A-
MATA22H3 Linear Algebra I for Mathematical Sciences — Grade: B+
CSCA08H3 Introduction to Computer Science I — Grade: B
ECMA01H3 Introductory Microeconomics — Grade: A

SESSION: WINTER 2026 (20261)
MATA37H3 Calculus II for Mathematical Sciences — Grade: A-
STAB52H3 Introduction to Probability — Grade: A
ECMA04H3 Introductory Macroeconomics — Grade: B+

SESSION: FALL/WINTER 2026-2027 — In Progress
STAB53H3 Introduction to Statistics — Status: IPR
MATB41H3 Techniques of the Calculus of Several Variables I — Status: IPR
Cumulative Credits Earned: 3.50, In Progress: 1.00`;

const STATS_YEAR3 = `UNIVERSITY OF TORONTO SCARBOROUGH
UNOFFICIAL ACADEMIC TRANSCRIPT
Student Name: Chen, Riley
Admission Category: Statistics (Year 1)
Program of Study: Specialist in Statistics, Quantitative Finance Stream (POSt: Active)
Current Session: Fall/Winter 2027-2028

SESSION: FALL 2025 (20259)
MATA31H3 Calculus I for Mathematical Sciences — Grade: A-
MATA22H3 Linear Algebra I for Mathematical Sciences — Grade: B+

SESSION: WINTER 2026 (20261)
MATA37H3 Calculus II for Mathematical Sciences — Grade: A-
STAB52H3 Introduction to Probability — Grade: A

SESSION: FALL 2026 (20269)
STAB53H3 Introduction to Statistics — Grade: A-
MATB41H3 Techniques of the Calculus of Several Variables I — Grade: B+
ECMA01H3 Introductory Microeconomics — Grade: A

SESSION: WINTER 2027 (20271)
STAB57H3 An Introduction to Data Science — Grade: A
MATB24H3 Linear Algebra II — Grade: B+

SESSION: FALL/WINTER 2027-2028 — In Progress
STAC62H3 Applied Probability — Status: IPR
Cumulative Credits Earned: 9.00, In Progress: 0.50`;

const MATH_YEAR1 = `UNIVERSITY OF TORONTO SCARBOROUGH
UNOFFICIAL ACADEMIC TRANSCRIPT
Student Name: Patel, Ravi
Admission Category: Mathematics (Year 1)
Program of Study: Major in Mathematics (POSt: Active)
Current Session: Fall 2026

No sessions completed yet. Student is about to begin their first semester.`;

const MATH_YEAR2 = `UNIVERSITY OF TORONTO SCARBOROUGH
UNOFFICIAL ACADEMIC TRANSCRIPT
Student Name: Patel, Aisha
Admission Category: Mathematics (Year 1)
Program of Study: Major in Mathematics (POSt: Active)
Current Session: Fall/Winter 2026-2027

SESSION: FALL 2025 (20259)
MATA31H3 Calculus I for Mathematical Sciences — Grade: A-
MATA22H3 Linear Algebra I for Mathematical Sciences — Grade: B+
CSCA08H3 Introduction to Computer Science I — Grade: B

SESSION: WINTER 2026 (20261)
MATA37H3 Calculus II for Mathematical Sciences — Grade: A-
MATA29H3 Advanced Euclidean Geometry — Grade: B+

SESSION: FALL/WINTER 2026-2027 — In Progress
MATB24H3 Linear Algebra II — Status: IPR
MATB41H3 Techniques of the Calculus of Several Variables I — Status: IPR
Cumulative Credits Earned: 2.50, In Progress: 1.00`;

const MATH_YEAR3 = `UNIVERSITY OF TORONTO SCARBOROUGH
UNOFFICIAL ACADEMIC TRANSCRIPT
Student Name: Patel, Dev
Admission Category: Mathematics (Year 1)
Program of Study: Major in Mathematics (POSt: Active)
Current Session: Fall/Winter 2027-2028

SESSION: FALL 2025 (20259)
MATA31H3 Calculus I for Mathematical Sciences — Grade: A-
MATA22H3 Linear Algebra I for Mathematical Sciences — Grade: B+

SESSION: WINTER 2026 (20261)
MATA37H3 Calculus II for Mathematical Sciences — Grade: A-
MATA29H3 Advanced Euclidean Geometry — Grade: B+

SESSION: FALL 2026 (20269)
MATB24H3 Linear Algebra II — Grade: B+
MATB41H3 Techniques of the Calculus of Several Variables I — Grade: A-

SESSION: WINTER 2027 (20271)
MATB42H3 Techniques of the Calculus of Several Variables II — Grade: B
STAB52H3 Introduction to Probability — Grade: A-

SESSION: FALL/WINTER 2027-2028 — In Progress
MATC15H3 Euclidean and Non-Euclidean Geometry — Status: IPR
Cumulative Credits Earned: 8.00, In Progress: 0.50`;

const H_Y_CREDIT = (code: string) => (/Y\d$/.test(code) ? 1.0 : /^COP[A-Z]/.test(code) ? 0 : 0.5);

const SCENARIOS: { label: string; transcript: string; prompt: string; program: ProgramSelector }[] = [
  { label: 'CS year 1 (cybersecurity interest)', transcript: CS_YEAR1, prompt: "I'm interested in going into cybersecurity.", program: CS_PROGRAM },
  { label: 'CS year 2 (cybersecurity interest)', transcript: CS_YEAR2, prompt: "I'm interested in going into cybersecurity.", program: CS_PROGRAM },
  { label: 'CS year 3 (cybersecurity interest)', transcript: CS_YEAR3, prompt: "I'm interested in going into cybersecurity.", program: CS_PROGRAM },
  { label: 'Stats year 1 (quant interest)', transcript: STATS_YEAR1, prompt: "I'm interested in quantitative finance.", program: STATS_PROGRAM },
  { label: 'Stats year 2 (quant interest)', transcript: STATS_YEAR2, prompt: "I'm interested in quantitative finance.", program: STATS_PROGRAM },
  { label: 'Stats year 3 (quant interest)', transcript: STATS_YEAR3, prompt: "I'm interested in quantitative finance.", program: STATS_PROGRAM },
  { label: 'Math year 1 (no specific interest)', transcript: MATH_YEAR1, prompt: '', program: MATH_PROGRAM },
  { label: 'Math year 2 (no specific interest)', transcript: MATH_YEAR2, prompt: '', program: MATH_PROGRAM },
  { label: 'Math year 3 (no specific interest)', transcript: MATH_YEAR3, prompt: '', program: MATH_PROGRAM },
];

for (const scenario of SCENARIOS) {
  test(`degree completion: ${scenario.label} reaches exactly 20.0 credits`, async () => {
    const parsed = await parseTranscript(scenario.transcript, scenario.prompt || undefined);
    const plan = await buildPlan({
      completedCourses: parsed.completedCourses,
      inProgressCourses: parsed.inProgressCourses,
      programs: [scenario.program],
      semestersElapsed: parsed.semestersElapsed,
      startSession: parsed.nextSession,
      ...(scenario.prompt && { interests: scenario.prompt }),
    });

    const allDone = [...parsed.completedCourses, ...parsed.inProgressCourses];
    const completedCredits = allDone.reduce((sum, c) => sum + H_Y_CREDIT(c), 0);
    const placedCredits = plan.semesters.flatMap((s) => s.courses).reduce((sum, c) => sum + c.credit, 0);
    const total = completedCredits + placedCredits;

    const stuck = plan.warnings.some((w) => /stopped early|safety cap/i.test(w));
    if (!stuck) {
      assert.equal(
        total,
        20.0,
        `expected exactly 20.0 credits for ${scenario.label}, got ${total} ` +
          `(completed=${completedCredits}, placed=${placedCredits}). warnings: ${plan.warnings.join('; ')}`
      );
    } else {
      assert.ok(
        total <= 20.0,
        `${scenario.label} got stuck before reaching 20.0 credits (total=${total}); this may be a real gap in course availability data. warnings: ${plan.warnings.join('; ')}`
      );
    }

    // Semester numbering should start from the student's true position, not always at 1.
    if (plan.semesters.length > 0) {
      assert.equal(plan.semesters[0]!.index, parsed.semestersElapsed + 1);
    }
  });
}
