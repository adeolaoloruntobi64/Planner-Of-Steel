import type { Campus } from './courses/calendar';
import { getCourseInfo } from './courses/cache';
import { retrieveTree, type CourseNode } from './courses/retrieveTree';
import { getCourseOfferings, type Session } from './courses/ttb';
import { chooseSections, type CourseSectionGroup } from './courses/sections';
import { getProgramRequirements } from './programs/cache';
import type { ElectiveGroup } from './programs/requirements';
import { pushStep } from './debug/status';
import { rankElectiveOptions } from './electivePreferences';

// Safety cap so an unsatisfiable requirement graph (e.g. a permanently-unavailable course)
// can't loop forever when semesters is left unset ("plan to the end of the degree").
const MAX_SEMESTERS = 20;

// A UofT Honours Bachelor's degree requires a minimum of 20.0 credits total, regardless of
// how the program combination (Specialist/Major/Minor) is shaped — a program's own required
// list is usually a subset of that (e.g. ~14-16 credits for a CS Specialist). "Plan to
// completion" means finishing the whole degree, not just the program-specific requirement
// list, so once those are satisfied the planner keeps filling semesters with free-elective
// credit up to this total.
const DEGREE_CREDIT_TARGET = 20.0;

// A normal full-time UofT course load is 5 half-courses (2.5 credits) per term, not 10 —
// using a higher default made "plan to completion" finish in unrealistically few semesters.
const DEFAULT_MAX_CREDITS_PER_SEMESTER = 2.5;

// UofT co-op work-term "courses" (e.g. COPC01H3 "First work term") carry no credit weight and
// represent a term spent working, not studying — recognized here so credit totals stay
// accurate and so that semester can be labeled distinctly instead of getting free-elective
// filler piled on top of it.
const WORK_TERM_RE = /^COPC0[1-5]H3$/;
const COOP_COURSE_RE = /^COP[A-Z]/;

export interface ProgramSelector {
  campus: Campus;
  sectionSlug: string;
  programCode: string;
}

export interface PlannerOptions {
  completedCourses: string[];
  /** Currently-enrolled courses, assumed to complete — counted toward requirements/credits like completedCourses, but reported separately for display. */
  inProgressCourses?: string[];
  programs: ProgramSelector[];
  /** Omit to plan every remaining semester until the program(s) are complete. */
  semesters?: number;
  maxCreditsPerSemester?: number;
  startSession?: Session;
  /** How many terms (Fall/Winter/Summer) have already happened, so output numbering reflects the student's true position (e.g. starting at semester 6, not 1). */
  semestersElapsed?: number;
  /** Freeform career/interest text (e.g. "cybersecurity") used to prioritize which elective options get picked when a group offers a choice. Omit for a broad, well-rounded selection. */
  interests?: string;
}

export interface PlannerCoreOptions {
  completedCourses: string[];
  inProgressCourses?: string[];
  semesters?: number;
  maxCreditsPerSemester?: number;
  startSession?: Session;
  semestersElapsed?: number;
  interests?: string;
}

export type PlacementCategory = 'required' | 'elective' | 'breadth' | 'interest' | 'free-elective';

export interface PlacedCourse {
  code: string;
  title: string;
  credit: number;
  session?: Session;
  sections?: { code: string; type: string; conflictsWith: string[] }[];
  /** Why this course is in the plan: 'required' can't be swapped; everything else can be
   * replaced with a different course satisfying the same choice/credit without breaking anything. */
  category: PlacementCategory;
}

export interface SemesterPlan {
  index: number;
  session: Session;
  /** 'work' when this semester is a co-op work term rather than a normal course load. */
  type: 'academic' | 'work';
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
  history: { completed: string[]; inProgress: string[] };
  semesters: SemesterPlan[];
  stillNeeded: string[];
  electiveGroupsRemaining: ElectiveGroupStatus[];
  warnings: string[];
}

function creditFor(code: string): number {
  if (COOP_COURSE_RE.test(code)) return 0; // co-op courses carry no credit weight
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
  const inProgressCourses = opts.inProgressCourses ?? [];
  const completed = new Set([...opts.completedCourses, ...inProgressCourses].map((c) => c.toUpperCase()));
  const maxCredits = opts.maxCreditsPerSemester ?? DEFAULT_MAX_CREDITS_PER_SEMESTER;
  const planToCompletion = opts.semesters === undefined;
  const semesterCap = opts.semesters ?? MAX_SEMESTERS;
  const semestersElapsed = opts.semestersElapsed ?? 0;
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

  // A candidate is already satisfied for CREDIT purposes if the student completed something
  // that excludes it (UofT's exclusion lists are mutually-equivalent course sets, e.g. CSCA08H3
  // vs CSC108H1) — but an exclusion is NOT the same thing as a prerequisite equivalence. Two
  // courses can legitimately exclude each other (you can't get credit for both, since their
  // content overlaps) while a THIRD course's calendar entry still names only one of them as its
  // specific prerequisite (e.g. MATA37H3 requires MATA31H3 specifically, even though MATA30H3
  // excludes MATA31H3 for credit purposes) — computed early since the prerequisite-closure step
  // right below needs it to know whether a course "counts" as reachable through the required
  // list, or has effectively dropped out of it.
  const isExcludedByCompleted = (code: string) => infoByCode.get(code)?.excludes.some((ex) => completed.has(ex)) ?? false;

  // A required course can depend on a prerequisite the student never took, and that isn't
  // actually going to get scheduled — either because it's not a listed program requirement or
  // elective option at all (e.g. an intro course only reachable transitively), or because it
  // WAS on the required list but dropped off it via the exclusion logic just above (credit for
  // it isn't needed, but that doesn't mean a DIFFERENT required course's specific prerequisite
  // is satisfied by the exclusion-equivalent it was replaced by). A student who took MATA30H3
  // instead of the required MATA31H3 doesn't need extra credit for MATA31H3, but MATA37H3 (a
  // real program requirement) still specifically needs it — without this, MATA37H3 (and
  // everything chained off it) sits permanently "unreachable" for the rest of the plan, while
  // bonus-fill keeps burying that fact under semester after semester of unrelated elective
  // filler — exactly backwards from "core requirements matter more than electives".
  //
  // Auto-adding the missing prerequisite (the first OR-alternative, as a reasonable default —
  // still swappable in reality, just not by this planner) turns a permanently-stuck plan into
  // one that correctly schedules the catch-up course first. `forcedPrerequisites` remembers
  // which codes were added this way, so the exclusion logic doesn't drop them straight back out
  // once they're back in the required set. Bounded rounds handle chains (a newly-added
  // prerequisite can itself need an earlier one) without looping forever.
  const forcedPrerequisites = new Set<string>();
  const doneResolvingPrereqs = pushStep('Resolving any missing transitive prerequisites');
  for (let round = 0; round < 6; round++) {
    const missing = new Set<string>();
    const effectivelyRequired = (code: string) => requiredSet.has(code) && (forcedPrerequisites.has(code) || !isExcludedByCompleted(code));
    for (const code of requiredSet) {
      if (!effectivelyRequired(code)) continue; // this course itself won't actually be scheduled, so its own prereqs don't matter
      const node = infoByCode.get(code);
      if (!node) continue;
      for (const group of node.prereqGroups) {
        if (group.length === 0) continue;
        const reachable = group.some((alt) => completed.has(alt) || effectivelyRequired(alt) || missing.has(alt));
        if (!reachable) missing.add(group[0]!);
      }
    }
    if (missing.size === 0) break;

    await Promise.all(
      [...missing].map(async (code) => {
        if (infoByCode.has(code)) return;
        try {
          infoByCode.set(code, await retrieveTree(code, 1));
        } catch (err) {
          missing.delete(code); // can't schedule what we can't even fetch info for
          warnings.push(`Could not fetch info for implied prerequisite ${code}: ${err instanceof Error ? err.message : String(err)}`);
        }
      })
    );
    for (const code of missing) {
      if (forcedPrerequisites.has(code)) continue; // already handled in an earlier round
      forcedPrerequisites.add(code);
      if (requiredSet.has(code)) {
        // Already nominally on the required list, but excluded-for-credit by something the
        // student completed — that exclusion doesn't carry over to satisfying THIS specific
        // prerequisite, so it needs to stay in the plan despite the exclusion.
        warnings.push(
          `Kept ${code} in the plan despite an exclusion from a completed course: another requirement's prerequisite specifically needs ${code}, which that exclusion doesn't satisfy.`
        );
      } else {
        requiredSet.add(code);
        warnings.push(`Added ${code} to the plan: it's a prerequisite for a program requirement that your transcript doesn't show as completed.`);
      }
    }
  }
  doneResolvingPrereqs();

  // A course code scraped from a program's requirements page can be stale (renamed,
  // discontinued, or just not currently offered) without the calendar page itself 404ing, so
  // fetching prereq info alone doesn't catch it — the solver would otherwise get permanently
  // stuck re-attempting it every semester with only a vague "unreachable" warning at the end.
  // Checking this upfront (rather than only at semester-0 scheduling time) surfaces the real
  // reason immediately; getCourseOfferings() is cached, so this doesn't cost a second live
  // lookup when semester 0 later checks the same course for real scheduling.
  //
  // Scoped to unconditionally-required courses only, not elective-group options: a required
  // course going missing can permanently strand the plan (exactly the failure this guards
  // against), while an elective option going missing just means one fewer choice in a group
  // that usually has several — checking all of those too (sometimes 50+ options in a big
  // elective menu) would multiply this pass's Steel calls well beyond what the fix is for,
  // and elective options that turn out unavailable are still skipped safely later when they'd
  // actually be scheduled.
  // Co-op work-term "courses" never appear in a TTB search (they're not timetabled, just
  // registered through the co-op office) — this check would always misread that as
  // "discontinued" and wrongly exclude a legitimate requirement.
  const codesToValidate = [...requiredSet].filter((c) => infoByCode.has(c) && !WORK_TERM_RE.test(c));
  const doneValidating = pushStep(`Checking ${codesToValidate.length} course(s) for current availability`);
  await Promise.all(
    codesToValidate.map(async (code) => {
      // A network hiccup (timeout, dropped connection) is not the same as "this course is
      // discontinued" — excluding a real, satisfiable requirement over a transient failure
      // would permanently strand the plan. Retry once before giving up on the check entirely;
      // only a successful lookup that genuinely finds zero offerings counts as "unavailable".
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const offerings = await getCourseOfferings(code);
          if (offerings.offerings.length === 0) {
            infoByCode.delete(code);
            warnings.push(`${code} doesn't appear in any current offering search — it may be discontinued, renamed, or simply not offered this year. Excluded from planning.`);
          }
          return;
        } catch (err) {
          if (attempt === 1) {
            warnings.push(`Could not confirm ${code} is currently available after retrying (kept in the plan anyway rather than risk excluding a real requirement): ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    })
  );
  doneValidating();

  // When an elective group offers more options than it needs, prioritize the ones that best
  // match the student's stated interest (or broad/well-rounded coverage if none was given)
  // instead of whatever order they happened to be scraped in.
  await Promise.all(
    groups.map(async (g) => {
      if (g.options.length <= 1 || g.chooseCount <= 0) return;
      const withTitles = g.options.map((code) => ({ code, title: infoByCode.get(code)?.title ?? code }));
      g.options = await rankElectiveOptions(g.description, withTitles, opts.interests);
    })
  );

  // Breadth-requirement awareness for free-credit filling: the set of categories that show up
  // at all among this student's known candidate courses is the "universe" worth caring about,
  // and a category already covered by something completed/in-progress doesn't need a slot
  // reserved for it later. This is a best-effort heuristic, not a verified formal breadth rule
  // (we don't have a scraped source for the exact degree-wide breadth policy) — it just avoids
  // spending free-elective slots on a category the student has already touched.
  const knownBreadthCategories = new Set([...infoByCode.values()].map((n) => n.breadthRequirement).filter((b): b is string => !!b));
  const coveredBreadth = new Set<string>();
  await Promise.all(
    [...completed].map(async (code) => {
      try {
        const info = await getCourseInfo(code);
        if (info.breadthRequirement) coveredBreadth.add(info.breadthRequirement);
      } catch {
        // completed courses that fail to fetch just don't contribute breadth info; harmless
      }
    })
  );

  // forcedPrerequisites (computed above) overrides the exclusion drop: a course that's
  // technically excluded-for-credit can still be structurally necessary because a different
  // required course's prerequisite specifically names it.
  const requiredRemaining = new Set([...requiredSet].filter((c) => forcedPrerequisites.has(c) || !isExcludedByCompleted(c)));

  const groupRemaining = groups.map((g) => {
    const satisfied = g.options.filter((c) => completed.has(c) || isExcludedByCompleted(c)).length;
    return Math.max(0, g.chooseCount - satisfied);
  });
  const groupIndicesForCode = (code: string) => groups.reduce<number[]>((acc, g, i) => (g.options.includes(code) ? [...acc, i] : acc), []);

  const satisfied = new Set(completed);
  const placedOverall = new Set<string>();
  const semesters: SemesterPlan[] = [];
  let session: Session = opts.startSession ?? 'F';
  let totalCredits = [...completed].reduce((sum, c) => sum + creditFor(c), 0);
  let freeElectiveCount = 0;
  // Rotates across elective groups for interest-based bonus filling (see below) so a single
  // group with many leftover options can't monopolize every bonus slot in the entire plan and
  // starve a different, smaller group of its own on-topic options.
  let interestGroupCursor = 0;

  const hasRemainingWork = () =>
    [...requiredRemaining].some((c) => !placedOverall.has(c)) ||
    groupRemaining.some((n) => n > 0) ||
    (planToCompletion && totalCredits < DEGREE_CREDIT_TARGET);

  for (let i = 0; i < semesterCap; i++) {
    if (!hasRemainingWork()) break; // nothing left to schedule

    const doneSemesterStep = pushStep(`Building semester ${i + 1 + semestersElapsed}${planToCompletion ? '' : ` of ${semesterCap}`} (${session})`);

    const prereqOk = (code: string) => {
      const node = infoByCode.get(code);
      if (!node) return false;
      // AND of OR-groups: every group needs at least one satisfied alternative.
      return node.prereqGroups.every((group) => group.some((p) => satisfied.has(p)));
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

    const placedThisSemester: { code: string; title: string; credit: number; session?: Session; offeredSections?: CourseSectionGroup; category: PlacementCategory }[] = [];
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
      // Co-op work-term "courses" (COPC01-05H3) are registered through the co-op office, not
      // the normal course timetable — they never appear in a TTB search at all, so the live
      // offerings check below would always treat them as unavailable and defer them forever.
      // Schedule them the same way later (non-live-checked) semesters already are.
      for (const { code, credit } of attempted) {
        if (!WORK_TERM_RE.test(code)) continue;
        const node = infoByCode.get(code)!;
        const category: PlacementCategory = requiredRemaining.has(code) ? 'required' : 'elective';
        placedThisSemester.push({ code, title: node.title, credit, category });
      }

      // Only the nearest semester has real, checkable sections; later semesters are
      // hypothetical since their sections aren't posted yet. Run these concurrently —
      // the Steel session pool bounds actual parallelism, so this is far faster than
      // awaiting them one at a time.
      const offeringResults = await Promise.all(
        attempted
          .filter(({ code }) => !WORK_TERM_RE.test(code))
          .map(async ({ code }) => {
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
        const category: PlacementCategory = requiredRemaining.has(code) ? 'required' : 'elective';
        placedThisSemester.push({ code, title: node.title, credit, session: match.session, offeredSections: { code, sections: match.sections }, category });
      }
    } else {
      for (const { code, credit } of attempted) {
        const node = infoByCode.get(code)!;
        const category: PlacementCategory = requiredRemaining.has(code) ? 'required' : 'elective';
        placedThisSemester.push({ code, title: node.title, credit, category });
      }
    }

    const isWorkSemester = placedThisSemester.some((c) => WORK_TERM_RE.test(c.code));

    // Once program-specific requirements are exhausted for this semester, top up toward a
    // realistic full course load (maxCredits) rather than leaving an under-full semester just
    // because the required/elective candidates ran out early — a real student takes close to a
    // full load most terms, not whatever the bare requirement list happens to produce. Skip
    // this for a work-term semester — a co-op student isn't taking a normal course load that
    // term.
    //
    // Preference order per slot: (1) a real course covering a breadth category nothing placed
    // so far touches, (2) a real course matching the student's stated interest (leftover,
    // already-ranked elective-group options beyond what was needed to satisfy chooseCount),
    // (3) only if neither applies AND we're planning all the way to degree completion, a
    // generic "free elective" placeholder — genuinely open, since the student gave us nothing
    // to target and every known relevant course is spoken for. In a BOUNDED "just show me the
    // next N semesters" plan, we stop instead of inventing filler — that mode is meant to
    // reflect real, identifiable courses only, not manufacture placeholders past what's known.
    if (!isWorkSemester) {
      let usedSoFar = placedThisSemester.reduce((sum, c) => sum + c.credit, 0);
      const takenThisPass = new Set(placedThisSemester.map((c) => c.code));

      const tryBonusCandidate = async (code: string): Promise<{ code: string; title: string; credit: number; session?: Session; offeredSections?: CourseSectionGroup } | null> => {
        if (placedOverall.has(code) || takenThisPass.has(code)) return null;
        const node = infoByCode.get(code);
        if (!node) return null;
        if (!node.prereqGroups.every((group) => group.some((p) => satisfied.has(p)))) return null;
        const credit = creditFor(code);
        // The 20.0-credit degree target only bounds a plan-to-completion run; a bounded
        // "next N semesters" preview has no such ceiling to respect.
        if (usedSoFar + credit > maxCredits || (planToCompletion && totalCredits + usedSoFar + credit > DEGREE_CREDIT_TARGET)) return null;

        if (i === 0) {
          try {
            const offerings = await getCourseOfferings(code);
            const match = offerings.offerings.find((o) => o.session === session || o.session === 'Y');
            if (!match) return null;
            return { code, title: node.title, credit, session: match.session, offeredSections: { code, sections: match.sections } };
          } catch {
            return null;
          }
        }
        return { code, title: node.title, credit };
      };

      while (usedSoFar + 0.5 <= maxCredits && (!planToCompletion || totalCredits + usedSoFar + 0.5 <= DEGREE_CREDIT_TARGET)) {
        let bonus: Awaited<ReturnType<typeof tryBonusCandidate>> = null;
        let bonusCategory: PlacementCategory = 'breadth';

        const missingBreadth = [...knownBreadthCategories].filter((b) => !coveredBreadth.has(b));
        if (missingBreadth.length > 0) {
          for (const [code, node] of infoByCode) {
            if (!node.breadthRequirement || !missingBreadth.includes(node.breadthRequirement)) continue;
            bonus = await tryBonusCandidate(code);
            if (bonus) break;
          }
        }

        if (!bonus && opts.interests && groups.length > 0) {
          bonusCategory = 'interest';
          // Start from wherever the last successful pick left off, not always groups[0] — a
          // big generic elective group (e.g. a broad breadth-elective menu) sitting earlier in
          // the array would otherwise supply every single interest-bonus slot in the whole
          // plan before a smaller, more specifically on-topic group (e.g. the CS-specific
          // elective list, where a stated interest like "cybersecurity" actually lives) ever
          // got a turn — exactly the bug behind "I asked for X and Y but only ever got Y".
          for (let attempt = 0; attempt < groups.length && !bonus; attempt++) {
            const g = groups[(interestGroupCursor + attempt) % groups.length]!;
            for (const code of g.options) {
              bonus = await tryBonusCandidate(code);
              if (bonus) break;
            }
            if (bonus) interestGroupCursor = (interestGroupCursor + attempt + 1) % groups.length;
          }
        }

        if (bonus) {
          placedThisSemester.push({ ...bonus, category: bonusCategory });
          takenThisPass.add(bonus.code);
          usedSoFar += bonus.credit;
          const breadth = infoByCode.get(bonus.code)?.breadthRequirement;
          if (breadth) coveredBreadth.add(breadth); // update now so the next slot this semester doesn't double up on the same category
        } else if (planToCompletion) {
          freeElectiveCount++;
          placedThisSemester.push({
            code: `FREE-ELECTIVE-${freeElectiveCount}`,
            title: 'Free elective (unspecified) — any course of your choice',
            credit: 0.5,
            category: 'free-elective',
          });
          usedSoFar += 0.5;
        } else {
          // Bounded preview mode: no real course/breadth/interest candidate is left to top up
          // with, and we don't invent generic filler here — stop instead of manufacturing a slot.
          break;
        }
      }
    }

    for (const { code, credit } of placedThisSemester) {
      placedOverall.add(code);
      satisfied.add(code);
      requiredRemaining.delete(code);
      totalCredits += credit;
      const breadth = infoByCode.get(code)?.breadthRequirement;
      if (breadth) coveredBreadth.add(breadth);
      for (const idx of groupIndicesForCode(code)) {
        groupRemaining[idx] = Math.max(0, groupRemaining[idx]! - 1);
      }
    }

    let sectionSelection: ReturnType<typeof chooseSections> | undefined;
    if (i === 0) {
      const groupsForSections = placedThisSemester.map((c) => c.offeredSections).filter((g): g is CourseSectionGroup => !!g);
      sectionSelection = chooseSections(groupsForSections);
      if (sectionSelection.hasUnresolvedConflicts) {
        warnings.push(`Some sections in semester ${i + 1 + semestersElapsed} conflict and no conflict-free combination was available.`);
      }
    }

    semesters.push({
      index: i + 1 + semestersElapsed,
      session,
      type: isWorkSemester ? 'work' : 'academic',
      courses: placedThisSemester.map((c) => ({
        code: c.code,
        title: c.title,
        credit: c.credit,
        category: c.category,
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

  return {
    programs: programNames,
    history: { completed: opts.completedCourses.map((c) => c.toUpperCase()), inProgress: inProgressCourses.map((c) => c.toUpperCase()) },
    semesters,
    stillNeeded,
    electiveGroupsRemaining,
    warnings,
  };
}
