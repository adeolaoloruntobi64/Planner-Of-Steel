import type { Campus } from './courses/calendar';
import { getCourseInfo } from './courses/cache';
import { retrieveTree, extractCodes, type CourseNode } from './courses/retrieveTree';
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

// A student on a full-time (usually 4-month) work placement isn't also carrying a normal
// course load — realistically at most one course, not the standard 2.5-credit/5-course term.
// Applied whenever a work-term course is actually going to be scheduled this semester, so real
// courses don't get greedily stacked in alongside a full-time placement.
const WORK_TERM_MAX_CREDITS = 0.5;

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
  /** Whether to actually schedule courses in summer terms. Defaults to false — summer shows up
   * as an explicit "break" placeholder in the plan either way, so the option to take courses
   * there is visible even when unused, rather than summer just silently not existing. */
  includeSummers?: boolean;
}

export interface PlannerCoreOptions {
  completedCourses: string[];
  inProgressCourses?: string[];
  semesters?: number;
  maxCreditsPerSemester?: number;
  startSession?: Session;
  semestersElapsed?: number;
  interests?: string;
  includeSummers?: boolean;
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
  /** 'work' for a co-op work term, 'break' for a summer term not being used for courses
   * (includeSummers is off) — either way, courses is empty. */
  type: 'academic' | 'work' | 'break';
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

// UofT's academic year is really three terms — Fall, Winter, Summer — not two. Summer cycles
// back in here (rather than being bolted on separately) so semester numbering/session tracking
// stays correct regardless of whether the student actually takes courses there; whether to
// actually schedule courses in it is a separate decision (see includeSummers in the main loop).
function nextSession(session: Session): Session {
  if (session === 'F') return 'S';
  if (session === 'S') return 'SU';
  return 'F';
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

  // A student explicitly naming a real course in their interests (e.g. "I want the extra 0.5
  // credit for the stats minor to be STAD68H3") is a much stronger signal than a general theme
  // like "cybersecurity" — it names one specific, known option. Without tracking that
  // separately, a discretionary elective slot the student clearly wants filled a particular way
  // can get silently absorbed by an unrelated required course covering the same category, or
  // consumed by whatever generic option happens to be reachable first — exactly the bug behind
  // "I named the exact course and it still picked something else". Checked with top priority in
  // the bonus-fill loop below, ahead of breadth and generic interest-ranked filling.
  const explicitlyRequestedCodes = opts.interests ? extractCodes(opts.interests).filter((code) => allCandidateCodes.includes(code)) : [];

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

  // UofT prereq text sometimes names only ONE stream's version of an interchangeable course —
  // e.g. co-op prep seminars differ by department (COPB55H3 Science / COPB57H3 CMS / COPB59H3
  // Arts), and COPC01H3's OWN prereq text documents all of them together as OR-alternatives —
  // but a DIFFERENT downstream course's prereq text (e.g. COPC98H3) might only mention
  // "COPB55H3", even for a student on a totally different, equally-valid stream. Rather than
  // guessing equivalence from exclusion lists (which also cover a narrower "no double credit
  // for near-duplicate content" relationship that ISN'T prereq-equivalent — e.g. MATA30H3
  // excludes MATA31H3, but MATA37H3 still specifically needs MATA31H3 itself, not just "a
  // similar calculus course"), only treat two codes as interchangeable when some course's OWN
  // prerequisite text already documents them together as OR-alternatives somewhere in the data
  // we've fetched — a confirmed equivalence, not an inferred one. Rebuilt via
  // refreshInterchangeableMap() as infoByCode grows (new codes fetched each closure round).
  const interchangeableWith = new Map<string, Set<string>>();
  function refreshInterchangeableMap(): void {
    interchangeableWith.clear();
    for (const node of infoByCode.values()) {
      for (const group of node.prereqGroups) {
        if (group.length < 2) continue;
        for (const code of group) {
          const set = interchangeableWith.get(code) ?? new Set<string>();
          for (const other of group) if (other !== code) set.add(other);
          interchangeableWith.set(code, set);
        }
      }
    }
  }
  refreshInterchangeableMap();
  const isSatisfied = (alt: string, satisfiedSet: Set<string>): boolean =>
    satisfiedSet.has(alt) || [...(interchangeableWith.get(alt) ?? [])].some((c) => satisfiedSet.has(c));

  // The flip side of the same equivalence: two courses that exclude each other should never
  // BOTH end up scheduled (e.g. STAB52H3 "Probability" and STAB53H3 "Applied Probability" cover
  // overlapping material and exclude one another) — checked against everything satisfied
  // (completed + already placed) plus whatever's being tentatively added in the same pass.
  // A course listed in another's "excludes" isn't always a true mutually-exclusive alternative
  // — UofT also uses "excludes" for sequential/nested courses (e.g. COPC02H3 excludes COPC01H3
  // simply because completing the later work term supersedes separate credit for the earlier
  // one, even though COPC02H3's own prerequisite REQUIRES COPC01H3 first). Two courses in a
  // direct prerequisite relationship are a stepping-stone chain, not alternatives, regardless
  // of what their exclusion lists say.
  const isDirectPrereqOf = (a: string, b: string): boolean => infoByCode.get(b)?.prereqGroups.some((group) => group.includes(a)) ?? false;

  const excludesConflict = (code: string, againstCodes: Iterable<string>): boolean => {
    const node = infoByCode.get(code);
    for (const other of againstCodes) {
      if (other === code) continue;
      if (isDirectPrereqOf(code, other) || isDirectPrereqOf(other, code)) continue;
      if (node?.excludes.includes(other)) return true;
      if (infoByCode.get(other)?.excludes.includes(code)) return true;
    }
    return false;
  };

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
    refreshInterchangeableMap(); // infoByCode may have grown a new forced-prerequisite's info last round
    const missing = new Set<string>();
    const effectivelyRequired = (code: string) => requiredSet.has(code) && (forcedPrerequisites.has(code) || !isExcludedByCompleted(code));
    const effectiveSet = new Set([...completed, ...[...requiredSet].filter(effectivelyRequired)]);
    for (const code of requiredSet) {
      if (!effectivelyRequired(code)) continue; // this course itself won't actually be scheduled, so its own prereqs don't matter
      const node = infoByCode.get(code);
      if (!node) continue;
      for (const group of node.prereqGroups) {
        if (group.length === 0) continue;
        const reachable = group.some((alt) => isSatisfied(alt, effectiveSet) || missing.has(alt));
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
  refreshInterchangeableMap(); // codesToValidate above may have dropped discontinued courses from infoByCode

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
  // How many semesters we've held off filling each group's chooseCount with a lower-ranked
  // (but currently reachable) option while a higher-ranked one is still blocked on its own
  // prerequisites — see the wait logic below.
  const groupWaitSemesters = groups.map(() => 0);
  const GROUP_WAIT_LIMIT = 3;

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

  const includeSummers = opts.includeSummers ?? false;
  // termIndex is the chronological term count (every real Fall/Winter/Summer term, whether or
  // not summer is actually being used for courses) — distinct from builtCount, which only
  // counts semesters actually scheduled and is what semesterCap bounds. That split is what lets
  // a skipped summer show up as an explicit placeholder between two real semesters without
  // eating into a bounded "plan the next N semesters" request or shifting its numbering.
  let builtCount = 0;
  let termIndex = semestersElapsed;

  while (builtCount < semesterCap) {
    if (session === 'SU' && !includeSummers) {
      if (!hasRemainingWork()) break; // plan's already done; no trailing break to show
      termIndex++;
      semesters.push({ index: termIndex, session: 'SU', type: 'break', courses: [] });
      session = nextSession(session);
      continue; // doesn't count against semesterCap — only real semesters do
    }

    if (!hasRemainingWork()) break; // nothing left to schedule

    const isFirstRealSemester = builtCount === 0;
    // Summer timetables publish much later in the year than Fall/Winter and often aren't up
    // yet at all — a live "is this actually offered" check would misread that as unavailable
    // and defer everything out of a summer term forever. Treat a summer term like any other
    // non-immediate, hypothetical semester instead, even if it happens to be the very first one.
    const canLiveCheck = isFirstRealSemester && session !== 'SU';
    const doneSemesterStep = pushStep(`Building semester ${termIndex + 1}${planToCompletion ? '' : ` of ${semesterCap}`} (${session})`);

    // Independent-study/project courses ("Readings in X", "X Project") are typically gated on
    // instructor/supervisor consent rather than any course or credit threshold — something this
    // planner has no way to verify or arrange, so they shouldn't get auto-picked as filler.
    // Still allowed if the program genuinely requires one outright, or the student explicitly
    // named it themselves (implying they'll handle arranging it).
    const isAutomaticallySchedulable = (code: string): boolean => {
      if (!infoByCode.get(code)?.requiresPermission) return true;
      return requiredSet.has(code) || explicitlyRequestedCodes.includes(code);
    };

    const prereqOk = (code: string) => {
      const node = infoByCode.get(code);
      if (!node) return false;
      if (!isAutomaticallySchedulable(code)) return false;
      // A credit-count/standing threshold with no course code (e.g. "14.0 credits and
      // enrolment in a Computer Science Subject POSt") parses to zero prereqGroups — an empty
      // AND-of-OR check is vacuously true, which used to let a 4th-year-only course get
      // scheduled in semester 1. Check it against total credits accumulated so far.
      if (node.minCreditsRequired !== undefined && totalCredits < node.minCreditsRequired) return false;
      // isSatisfied (documented-alternative equivalence), not a blanket exclusion-based guess:
      // an exclusion can mean "no double credit for near-duplicate content" (e.g. MATA30H3
      // excludes MATA31H3, but MATA37H3 still specifically needs MATA31H3 itself) rather than
      // "these are freely interchangeable" — that distinction is exactly what interchangeableWith
      // is built to respect.
      return node.prereqGroups.every((group) => group.some((p) => isSatisfied(p, satisfied)));
    };

    const candidates: string[] = [];
    for (const code of requiredRemaining) {
      if (!placedOverall.has(code) && prereqOk(code)) candidates.push(code);
    }
    groups.forEach((g, idx) => {
      if (groupRemaining[idx]! <= 0) return;
      // g.options is ranked best-fit-first (interest/broad ranking) — the first not-yet-placed
      // option is the group's current top choice. If it's genuinely the student's stated
      // preference (e.g. "I want STAD68H3 for this slot") but its OWN prerequisites haven't
      // been scheduled yet, immediately falling back to a lower-ranked-but-reachable option
      // would permanently consume the slot before the preferred one ever got a chance — the
      // exact bug behind "I asked for X but it picked something else entirely". Hold off for a
      // bounded number of semesters to let the preferred option's prereqs catch up, then give
      // up waiting so the requirement doesn't go permanently unsatisfied over one bad pick.
      const topChoice = g.options.find((code) => !placedOverall.has(code));
      const topChoiceReachable = topChoice !== undefined && prereqOk(topChoice);
      const stillWaitingOnTopChoice = topChoice !== undefined && !topChoiceReachable && groupWaitSemesters[idx]! < GROUP_WAIT_LIMIT;
      if (stillWaitingOnTopChoice) {
        groupWaitSemesters[idx]!++;
        return; // don't fill this group's slot with anything else yet
      }

      for (const code of g.options) {
        if (placedOverall.has(code) || candidates.includes(code)) continue;
        if (prereqOk(code)) candidates.push(code);
      }
    });

    // Predicted before anything's actually placed: if a work-term course is among this
    // semester's real candidates, the whole semester is a work term, and the normal full
    // course-load budget shouldn't apply to whatever else gets attempted alongside it.
    const predictedWorkTerm = candidates.some((code) => WORK_TERM_RE.test(code));
    const semesterMaxCredits = predictedWorkTerm ? WORK_TERM_MAX_CREDITS : maxCredits;

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
      // Never schedule two mutually-exclusive courses together (e.g. two equivalent
      // "which stream's prep seminar" options) just because both happened to be candidates —
      // checked against everything satisfied so far AND whatever's already queued this pass.
      // Exempt forced prerequisites: those were deliberately kept DESPITE an exclusion from a
      // completed course (see forcedPrerequisites above) — that's exactly the conflict this
      // check would otherwise re-block them for.
      if (!forcedPrerequisites.has(code) && excludesConflict(code, [...satisfied, ...attempted.map((a) => a.code)])) continue;

      const credit = creditFor(code);
      if (creditsUsed + credit > semesterMaxCredits) continue;
      creditsUsed += credit;
      attempted.push({ code, credit });
      for (const idx of memberGroups) groupTakenThisSemester[idx]!++;
    }

    if (canLiveCheck) {
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
        // A course that's still needed to satisfy a specific elective group's chooseCount must
        // be filled by that group's own ranked-preference selection, not grabbed opportunistically
        // as generic breadth/interest filler — otherwise a course the student has a clear,
        // stated preference for (e.g. "I want STAD68H3 for this slot") can get permanently
        // preempted by whatever ELSE happens to be reachable first, purely because the
        // preferred option's own prerequisites (e.g. CSCC11H3) haven't been scheduled yet. Once
        // a group's chooseCount is actually satisfied, its remaining options are fair game.
        // groupRemaining itself only updates once at the very end of the semester, AFTER this
        // bonus-fill pass — so also count whatever this SAME semester has already queued up for
        // the group (takenThisPass) as already spoken for, or a group satisfied earlier this
        // very semester would still look "unsatisfied" to every bonus check that follows it.
        const stillNeedsThisGroup = (idx: number) => groupRemaining[idx]! - groups[idx]!.options.filter((c) => takenThisPass.has(c)).length > 0;
        if (groupIndicesForCode(code).some(stillNeedsThisGroup)) return null;
        if (!isAutomaticallySchedulable(code)) return null;
        const node = infoByCode.get(code);
        if (!node) return null;
        if (node.minCreditsRequired !== undefined && totalCredits < node.minCreditsRequired) return null;
        if (!node.prereqGroups.every((group) => group.some((p) => isSatisfied(p, satisfied)))) return null;
        // A bonus pick (breadth/interest filler) must never conflict with anything already
        // completed or placed — e.g. STAB52H3 "Probability" and STAB53H3 "Applied Probability"
        // exclude each other; once one is scheduled, the other should never ALSO show up as a
        // "matches your interest" filler pick just because it wasn't the one already taken.
        if (excludesConflict(code, [...satisfied, ...takenThisPass])) return null;
        const credit = creditFor(code);
        // The 20.0-credit degree target only bounds a plan-to-completion run; a bounded
        // "next N semesters" preview has no such ceiling to respect.
        if (usedSoFar + credit > maxCredits || (planToCompletion && totalCredits + usedSoFar + credit > DEGREE_CREDIT_TARGET)) return null;

        if (canLiveCheck) {
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

        if (explicitlyRequestedCodes.length > 0) {
          for (const code of explicitlyRequestedCodes) {
            bonus = await tryBonusCandidate(code);
            if (bonus) break;
          }
          if (bonus) bonusCategory = 'interest';
        }

        const missingBreadth = !bonus ? [...knownBreadthCategories].filter((b) => !coveredBreadth.has(b)) : [];
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

    // A course just placed can satisfy a DIFFERENT still-outstanding requirement via mutual
    // exclusion (e.g. placing MATA22H3 means MATA23H3 — its equivalent alternative — doesn't
    // ALSO need to be taken), the same way a historically-completed exclusion already does.
    // Without this, excludesConflict (which correctly stops the two from being scheduled
    // together) would otherwise leave the excluded one permanently stuck in "still needed".
    // Forced prerequisites are exempt — they were deliberately kept despite an exclusion from a
    // completed course, so that same exclusion must not immediately un-require them again.
    for (const code of [...requiredRemaining]) {
      if (!forcedPrerequisites.has(code) && excludesConflict(code, satisfied)) requiredRemaining.delete(code);
    }

    let sectionSelection: ReturnType<typeof chooseSections> | undefined;
    if (canLiveCheck) {
      const groupsForSections = placedThisSemester.map((c) => c.offeredSections).filter((g): g is CourseSectionGroup => !!g);
      sectionSelection = chooseSections(groupsForSections);
      if (sectionSelection.hasUnresolvedConflicts) {
        warnings.push(`Some sections in semester ${termIndex + 1} conflict and no conflict-free combination was available.`);
      }
    }

    semesters.push({
      index: termIndex + 1,
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

    builtCount++;
    termIndex++;
    session = nextSession(session);
    doneSemesterStep();

    if (planToCompletion && placedThisSemester.length === 0 && hasRemainingWork()) {
      warnings.push('Stopped early: a full semester pass placed no new courses, so the remaining requirements look unreachable (unmet prerequisite chain or a course that never appears in any offering search).');
      break;
    }
  }

  if (planToCompletion && hasRemainingWork() && builtCount >= MAX_SEMESTERS) {
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
