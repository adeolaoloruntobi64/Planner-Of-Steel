import type { Campus } from './courses/calendar';
import { retrieveTree, type CourseNode } from './courses/retrieveTree';
import { getCourseOfferings, type Session } from './courses/ttb';
import { chooseSections, type CourseSectionGroup, type TimePreference } from './courses/sections';
import { getProgramRequirements } from './programs/cache';
import type { ElectiveGroup } from './programs/requirements';
import { pushStep } from './debug/status';

// Safety cap so an unsatisfiable requirement graph (e.g. a permanently-unavailable course)
// can't loop forever when semesters is left unset ("plan to the end of the degree").
const MAX_SEMESTERS = 20;

export interface ProgramSelector {
  campus: Campus;
  sectionSlug: string;
  programCode: string;
}

export interface PlannerOptions {
  completedCourses: string[];
  programs: ProgramSelector[];
  /** Omit to plan every remaining semester until the program(s) are complete. */
  semesters?: number;
  maxCreditsPerSemester?: number;
  startSession?: Session;
  timePreference?: TimePreference;
  allowConflicts?: boolean;
}

export interface PlannerCoreOptions {
  completedCourses: string[];
  semesters?: number;
  maxCreditsPerSemester?: number;
  startSession?: Session;
  timePreference?: TimePreference;
  allowConflicts?: boolean;
}

export interface PlacedCourse {
  code: string;
  title: string;
  credit: number;
  session?: Session;
  sections?: { code: string; type: string; conflictsWith: string[] }[];
}

export interface SemesterPlan {
  index: number;
  session: Session;
  courses: PlacedCourse[];
}

export interface ElectiveGroupStatus {
  description: string;
  chooseCount: number;
  stillNeed: number;
  options: string[];
}

export interface DegreePlan {
  programs: string[];
  semesters: SemesterPlan[];
  stillNeeded: string[];
  electiveGroupsRemaining: ElectiveGroupStatus[];
  warnings: string[];
}

function creditFor(code: string): number {
  return /Y\d$/.test(code) ? 1.0 : 0.5;
}

function nextSession(session: Session): Session {
  return session === 'F' ? 'S' : 'F';
}

export async function buildPlan(opts: PlannerOptions): Promise<DegreePlan> {
  const results = await Promise.all(
    opts.programs.map((p) => getProgramRequirements(p.campus, p.sectionSlug, p.programCode))
  );

  const programNames = results.map((r) => r.name);
  const requiredCourses = [...new Set(results.flatMap((r) => r.requiredCourses))];
  const electiveGroups = results.flatMap((r) => r.electiveGroups);
  const initialWarnings = results.flatMap((r) => r.warnings);

  return buildPlanForCourses({ requiredCourses, electiveGroups }, programNames, opts, initialWarnings);
}

export async function buildPlanForCourses(
  requirements: { requiredCourses: string[]; electiveGroups: ElectiveGroup[] },
  programNames: string[],
  opts: PlannerCoreOptions,
  initialWarnings: string[] = []
): Promise<DegreePlan> {
  const completed = new Set(opts.completedCourses.map((c) => c.toUpperCase()));
  const maxCredits = opts.maxCreditsPerSemester ?? 5.0;
  const planToCompletion = opts.semesters === undefined;
  const semesterCap = opts.semesters ?? MAX_SEMESTERS;
  const warnings: string[] = [...initialWarnings];

  // A course belonging to both the unconditional list and an elective group's options is
  // just unconditional; drop it from the group so it isn't double-counted, and reduce the
  // group's chooseCount by however many of its options are covered that way — otherwise a
  // group whose options are entirely absorbed by another program's required list would report
  // a phantom "still need N more" with no options left to satisfy it.
  const allRequiredCodes = new Set(requirements.requiredCourses);
  const requiredSet = new Set(requirements.requiredCourses.filter((c) => !completed.has(c)));
  const groups = requirements.electiveGroups.map((g) => {
    const absorbedByRequired = g.options.filter((c) => allRequiredCodes.has(c)).length;
    return {
      ...g,
      chooseCount: Math.max(0, g.chooseCount - absorbedByRequired),
      options: g.options.filter((c) => !allRequiredCodes.has(c)),
    };
  });

  const allCandidateCodes = [...new Set([...requiredSet, ...groups.flatMap((g) => g.options)])];

  const infoByCode = new Map<string, CourseNode>();
  const doneFetchingInfo = pushStep(`Fetching prereq info for ${allCandidateCodes.length} course(s)`);
  await Promise.all(
    allCandidateCodes.map(async (code) => {
      try {
        infoByCode.set(code, await retrieveTree(code, 1));
      } catch (err) {
        warnings.push(`Could not fetch info for ${code}: ${err instanceof Error ? err.message : String(err)}`);
      }
    })
  );
  doneFetchingInfo();

  // A candidate is already satisfied if the student completed something that excludes it
  // (UofT's exclusion lists are mutually-equivalent course sets, e.g. CSCA08H3 vs CSC108H1).
  const isExcludedByCompleted = (code: string) => infoByCode.get(code)?.excludes.some((ex) => completed.has(ex)) ?? false;

  const requiredRemaining = new Set([...requiredSet].filter((c) => !isExcludedByCompleted(c)));

  const groupRemaining = groups.map((g) => {
    const satisfied = g.options.filter((c) => completed.has(c) || isExcludedByCompleted(c)).length;
    return Math.max(0, g.chooseCount - satisfied);
  });
  const groupIndicesForCode = (code: string) => groups.reduce<number[]>((acc, g, i) => (g.options.includes(code) ? [...acc, i] : acc), []);

  const satisfied = new Set(completed);
  const placedOverall = new Set<string>();
  const semesters: SemesterPlan[] = [];
  let session: Session = opts.startSession ?? 'F';

  const hasRemainingWork = () =>
    [...requiredRemaining].some((c) => !placedOverall.has(c)) || groupRemaining.some((n) => n > 0);

  for (let i = 0; i < semesterCap; i++) {
    if (!hasRemainingWork()) break; // nothing left to schedule

    const doneSemesterStep = pushStep(`Building semester ${i + 1}${planToCompletion ? '' : ` of ${semesterCap}`} (${session})`);

    const prereqOk = (code: string) => {
      const node = infoByCode.get(code);
      if (!node) return false;
      return node.prereqCourses.length === 0 || node.prereqCourses.some((p) => satisfied.has(p));
    };

    const candidates: string[] = [];
    for (const code of requiredRemaining) {
      if (!placedOverall.has(code) && prereqOk(code)) candidates.push(code);
    }
    groups.forEach((g, idx) => {
      if (groupRemaining[idx]! <= 0) return;
      for (const code of g.options) {
        if (placedOverall.has(code) || candidates.includes(code)) continue;
        if (prereqOk(code)) candidates.push(code);
      }
    });

    const placedThisSemester: { code: string; title: string; credit: number; session?: Session; offeredSections?: CourseSectionGroup }[] = [];
    let creditsUsed = 0;
    const attempted: { code: string; credit: number }[] = [];
    // Tracks how many options from each group have already been queued up THIS semester, so a
    // "choose 1 of 2" group can't have both options attempted in the same pass (groupRemaining
    // itself only updates once actual placements are known, at the end of the semester).
    const groupTakenThisSemester = groups.map(() => 0);

    for (const code of candidates) {
      const memberGroups = groupIndicesForCode(code);
      const isRequired = requiredRemaining.has(code);
      if (!isRequired && memberGroups.length > 0 && memberGroups.every((idx) => groupTakenThisSemester[idx]! >= groupRemaining[idx]!)) continue;

      const credit = creditFor(code);
      if (creditsUsed + credit > maxCredits) continue;
      creditsUsed += credit;
      attempted.push({ code, credit });
      for (const idx of memberGroups) groupTakenThisSemester[idx]!++;
    }

    if (i === 0) {
      // Only the nearest semester has real, checkable sections; later semesters are
      // hypothetical since their sections aren't posted yet. Run these concurrently —
      // the Steel session pool bounds actual parallelism, so this is far faster than
      // awaiting them one at a time.
      const offeringResults = await Promise.all(
        attempted.map(async ({ code }) => {
          try {
            return { code, offerings: await getCourseOfferings(code) };
          } catch (err) {
            warnings.push(`Could not check ${code} offerings, skipping this semester: ${err instanceof Error ? err.message : String(err)}`);
            return { code, offerings: null };
          }
        })
      );

      for (const { code, offerings } of offeringResults) {
        const node = infoByCode.get(code)!;
        const credit = creditFor(code);
        if (!offerings) continue;
        const match = offerings.offerings.find((o) => o.session === session || o.session === 'Y');
        if (!match) {
          warnings.push(`${code} does not appear to be offered in session ${session}; deferring to a later semester.`);
          continue;
        }
        placedThisSemester.push({ code, title: node.title, credit, session: match.session, offeredSections: { code, sections: match.sections } });
      }
    } else {
      for (const { code, credit } of attempted) {
        const node = infoByCode.get(code)!;
        placedThisSemester.push({ code, title: node.title, credit });
      }
    }

    for (const { code } of placedThisSemester) {
      placedOverall.add(code);
      satisfied.add(code);
      requiredRemaining.delete(code);
      for (const idx of groupIndicesForCode(code)) {
        groupRemaining[idx] = Math.max(0, groupRemaining[idx]! - 1);
      }
    }

    let sectionSelection: ReturnType<typeof chooseSections> | undefined;
    if (i === 0) {
      const groupsForSections = placedThisSemester.map((c) => c.offeredSections).filter((g): g is CourseSectionGroup => !!g);
      sectionSelection = chooseSections(groupsForSections, { timePreference: opts.timePreference, allowConflicts: opts.allowConflicts });
      if (sectionSelection.hasUnresolvedConflicts && !opts.allowConflicts) {
        warnings.push(`Some sections in semester ${i + 1} conflict and no conflict-free combination was available; kept anyway since allowConflicts was not set to reshuffle further.`);
      }
    }

    semesters.push({
      index: i + 1,
      session,
      courses: placedThisSemester.map((c) => ({
        code: c.code,
        title: c.title,
        credit: c.credit,
        ...(c.session && { session: c.session }),
        ...(sectionSelection && {
          sections: sectionSelection.chosen
            .filter((s) => s.courseCode === c.code)
            .map((s) => ({ code: s.section.code, type: s.section.type, conflictsWith: s.conflictsWith.map((cw) => `${cw.courseCode} ${cw.sectionCode}`) })),
        }),
      })),
    });

    session = nextSession(session);
    doneSemesterStep();

    if (planToCompletion && placedThisSemester.length === 0 && hasRemainingWork()) {
      warnings.push('Stopped early: a full semester pass placed no new courses, so the remaining requirements look unreachable (unmet prerequisite chain or a course that never appears in any offering search).');
      break;
    }
  }

  if (planToCompletion && hasRemainingWork() && semesters.length >= MAX_SEMESTERS) {
    warnings.push(`Reached the ${MAX_SEMESTERS}-semester safety cap with requirements still remaining.`);
  }

  const stillNeeded = [...requiredRemaining].filter((c) => !placedOverall.has(c));
  const electiveGroupsRemaining = groups
    .map((g, idx) => ({ description: g.description, chooseCount: g.chooseCount, stillNeed: groupRemaining[idx]!, options: g.options.filter((c) => !placedOverall.has(c)) }))
    .filter((g) => g.stillNeed > 0);

  return { programs: programNames, semesters, stillNeeded, electiveGroupsRemaining, warnings };
}
