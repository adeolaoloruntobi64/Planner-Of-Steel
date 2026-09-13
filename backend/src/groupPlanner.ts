import { buildPlan, type ProgramSelector, type DegreePlan } from './planner';
import type { Session } from './courses/ttb';
import { getProgramRequirements } from './programs/cache';
import { retrieveTree } from './courses/retrieveTree';
import { rankElectiveOptions } from './electivePreferences';
import { parseGroupConstraints, type GroupConstraint } from './groupConstraints';

export interface FriendInput {
  name: string;
  completedCourses: string[];
  inProgressCourses?: string[];
  programs: ProgramSelector[];
  semestersElapsed?: number;
  startSession?: Session;
  interests?: string;
}

export interface GroupPlanOptions {
  friends: FriendInput[];
  /** Freeform description of shared scheduling goals, e.g. "Alex and Sam want to take a course
   * together" or "we want to maximize overlap in 3rd year fall". Omit for independent plans
   * with no cross-friend suggestions. */
  constraintsPrompt?: string;
  semesters?: number;
}

export interface SharedSuggestion {
  constraintType: GroupConstraint['type'];
  friendNames: string[];
  code: string;
  title: string;
  /** The semester index (per that friend's own numbering) each named friend could take this in. */
  friendSemesters: { name: string; semesterIndex: number }[];
  note: string;
}

export interface GroupPlan {
  friends: { name: string; plan: DegreePlan }[];
  sharedSuggestions: SharedSuggestion[];
  warnings: string[];
}

/** A friend's full pool of candidate course codes (required + every elective group's options), independent of what they've already completed — the universe worth checking for cross-friend overlap. */
async function candidatePoolFor(friend: FriendInput): Promise<Set<string>> {
  const results = await Promise.all(friend.programs.map((p) => getProgramRequirements(p.campus, p.sectionSlug, p.programCode)));
  const codes = new Set<string>();
  for (const r of results) {
    for (const c of r.requiredCourses) codes.add(c);
    for (const g of r.electiveGroups) for (const c of g.options) codes.add(c);
  }
  return codes;
}

/**
 * The earliest semester (in this friend's OWN plan numbering) by which `code`'s prerequisites
 * would be satisfied, based on what they've already completed plus what their individual plan
 * places semester by semester. Returns undefined if the plan doesn't run far enough to tell, or
 * the course never becomes reachable within it — a lower bound estimate for suggestion purposes,
 * not a guarantee the course will actually be offered that term.
 */
async function earliestReachableSemester(plan: DegreePlan, code: string): Promise<number | undefined> {
  const placedAlready = plan.semesters.flatMap((s) => s.courses).find((c) => c.code === code);
  if (placedAlready) {
    const semester = plan.semesters.find((s) => s.courses.some((c) => c.code === code));
    return semester?.index;
  }

  let node;
  try {
    node = await retrieveTree(code, 1);
  } catch {
    return undefined;
  }

  const satisfied = new Set([...plan.history.completed, ...plan.history.inProgress]);
  const prereqOk = () => node!.prereqGroups.every((group) => group.some((p) => satisfied.has(p)));
  if (prereqOk()) return plan.semesters[0]?.index;

  for (const semester of plan.semesters) {
    for (const c of semester.courses) satisfied.add(c.code);
    if (prereqOk()) {
      const next = plan.semesters.find((s) => s.index > semester.index);
      return next?.index ?? semester.index + 1;
    }
  }
  return undefined; // not reachable within the planned horizon
}

interface SharedCandidateResult {
  code: string;
  title: string;
  friendSemesters: { name: string; semesterIndex: number }[];
  /** True if every friend's OWN plan already places this course — a free win, no swap needed. */
  alreadyAligned: boolean;
}

/**
 * Scans candidate codes (in the given priority order) for ones every friend could take around
 * the same time, optionally restricted to a specific [minSemester, maxSemester] window (e.g. a
 * requested year of study). Returns up to `limit` results, already-aligned ones (every friend's
 * own plan places it there with no changes) sorted first, then by soonest shared semester.
 */
async function rankedSharedCandidates(
  friendPlans: { name: string; plan: DegreePlan }[],
  candidateCodes: string[],
  options: { semesterRange?: [number, number]; limit: number; scanLimit: number }
): Promise<SharedCandidateResult[]> {
  const results: SharedCandidateResult[] = [];

  for (const code of candidateCodes.slice(0, options.scanLimit)) {
    const perFriend = friendPlans.map(({ name, plan }) => ({
      name,
      plan,
      placedSemester: plan.semesters.find((s) => s.courses.some((c) => c.code === code)),
    }));
    const alreadyAligned = perFriend.every((f) => f.placedSemester);

    let friendSemesters: { name: string; semesterIndex: number }[];
    if (alreadyAligned) {
      friendSemesters = perFriend.map((f) => ({ name: f.name, semesterIndex: f.placedSemester!.index }));
    } else {
      const resolved = await Promise.all(
        perFriend.map(async (f) => ({
          name: f.name,
          semesterIndex: f.placedSemester?.index ?? (await earliestReachableSemester(f.plan, code)),
        }))
      );
      if (resolved.some((f) => f.semesterIndex === undefined)) continue;
      friendSemesters = resolved as { name: string; semesterIndex: number }[];
    }

    if (options.semesterRange) {
      const [lo, hi] = options.semesterRange;
      if (!friendSemesters.every((f) => f.semesterIndex >= lo && f.semesterIndex <= hi)) continue;
    }

    let title = code;
    try {
      title = (await retrieveTree(code, 0)).title;
    } catch {
      // fall back to the bare code if the title lookup fails
    }

    results.push({ code, title, friendSemesters, alreadyAligned });
  }

  results.sort((a, b) => {
    if (a.alreadyAligned !== b.alreadyAligned) return a.alreadyAligned ? -1 : 1;
    const maxA = Math.max(...a.friendSemesters.map((f) => f.semesterIndex));
    const maxB = Math.max(...b.friendSemesters.map((f) => f.semesterIndex));
    return maxA - maxB;
  });

  return results.slice(0, options.limit);
}

/**
 * Plans each friend's degree independently (each gets their own realistic, correct plan —
 * nothing about one friend's requirements or prerequisites should ever bend to accommodate
 * another), then layers on best-effort cross-friend suggestions for any stated shared goals
 * ("take a course together", "maximize overlap"). Suggestions are advisory: swap-in candidates
 * a friend could substitute for one of their own swappable elective/breadth slots, not a
 * guarantee baked into their plan, since forcing a specific course into a specific semester for
 * one friend could break correctness (prereqs, credit caps, offerings) for THEIR OWN plan.
 */
export async function buildGroupPlan(opts: GroupPlanOptions): Promise<GroupPlan> {
  const warnings: string[] = [];

  const friendPlans = await Promise.all(
    opts.friends.map(async (f) => ({
      name: f.name,
      plan: await buildPlan({
        completedCourses: f.completedCourses,
        programs: f.programs,
        ...(f.inProgressCourses !== undefined && { inProgressCourses: f.inProgressCourses }),
        ...(f.semestersElapsed !== undefined && { semestersElapsed: f.semestersElapsed }),
        ...(f.startSession !== undefined && { startSession: f.startSession }),
        ...(f.interests !== undefined && { interests: f.interests }),
        ...(opts.semesters !== undefined && { semesters: opts.semesters }),
      }),
    }))
  );

  const sharedSuggestions: SharedSuggestion[] = [];

  if (opts.constraintsPrompt) {
    const constraints = await parseGroupConstraints(
      opts.constraintsPrompt,
      opts.friends.map((f) => f.name)
    );
    if (constraints.length === 0) {
      warnings.push('Could not extract any actionable shared scheduling goal from the group prompt; each friend got an independent plan only.');
    }

    const pools = new Map<string, Set<string>>();
    await Promise.all(
      opts.friends.map(async (f) => {
        pools.set(f.name, await candidatePoolFor(f));
      })
    );

    // Every involved friend's own candidate pool, intersected — a course that isn't even a
    // possible option for one of them isn't a real suggestion. Also drops anything ANY of them
    // has already completed or is currently taking: you can't take a course "together" (or
    // count it as shared) if one of you has already done it.
    function commonCandidates(group: { name: string; plan: DegreePlan }[]): string[] {
      return [...pools.get(group[0]!.name)!].filter(
        (code) =>
          group.every((fp) => pools.get(fp.name)!.has(code)) &&
          group.every((fp) => !fp.plan.history.completed.includes(code) && !fp.plan.history.inProgress.includes(code))
      );
    }

    async function suggestFor(constraint: GroupConstraint, group: { name: string; plan: DegreePlan }[]): Promise<void> {
      const commonCodes = commonCandidates(group);
      const names = group.map((fp) => fp.name).join(' and ');
      if (commonCodes.length === 0) {
        warnings.push(`No course appears in every requirement/elective list for ${names} — no shared-course suggestion possible for that goal.`);
        return;
      }

      let ranked = commonCodes;
      if (constraint.type === 'take-together' && constraint.courseHint) {
        const withTitles = await Promise.all(
          commonCodes.map(async (code) => {
            try {
              return { code, title: (await retrieveTree(code, 0)).title };
            } catch {
              return { code, title: code };
            }
          })
        );
        ranked = await rankElectiveOptions(constraint.courseHint, withTitles, constraint.courseHint);
      }

      const targetYear = constraint.type === 'maximize-shared' ? constraint.targetYear : undefined;
      const semesterRange: [number, number] | undefined = targetYear ? [2 * targetYear - 1, 2 * targetYear] : undefined;
      const limit = constraint.type === 'take-together' ? 1 : 5;
      const scanLimit = constraint.type === 'take-together' ? 15 : 30;

      const results = await rankedSharedCandidates(group, ranked, { ...(semesterRange && { semesterRange }), limit, scanLimit });
      if (results.length === 0) {
        warnings.push(
          semesterRange
            ? `Found shared candidate courses for ${names} but none land in year ${targetYear} for everyone given current prerequisites — no suggestion made.`
            : `Found shared candidate courses for ${names} but none were reachable given current prerequisites — no suggestion made.`
        );
        return;
      }

      for (const r of results) {
        const maxSemester = Math.max(...r.friendSemesters.map((f) => f.semesterIndex));
        const note =
          constraint.type === 'take-together'
            ? `${names} could both take ${r.code} by semester ${maxSemester} — swap it in for one of your own elective/breadth slots around then.`
            : r.alreadyAligned
              ? `${r.code} already lines up for ${names} around semester ${maxSemester}${constraint.timeframeHint ? ` (${constraint.timeframeHint})` : ''} — no changes needed for this one.`
              : `${r.code} is a shared option ${names} could all reach by semester ${maxSemester}${constraint.timeframeHint ? ` (requested timeframe: "${constraint.timeframeHint}")` : ''} — swap it in for one of your own elective/breadth slots.`;

        sharedSuggestions.push({
          constraintType: constraint.type,
          friendNames: group.map((fp) => fp.name),
          code: r.code,
          title: r.title,
          friendSemesters: r.friendSemesters,
          note,
        });
      }
    }

    for (const constraint of constraints) {
      const involved = friendPlans.filter((fp) => constraint.friendNames.some((n) => n.toLowerCase() === fp.name.toLowerCase()));
      if (involved.length < 2) continue;

      await suggestFor(constraint, involved);

      // A group of 3+ with different programs may have thin overlap across everyone at once
      // (differing majors rarely share upper-year required courses) even though PAIRS within
      // the group overlap a lot — worth surfacing separately rather than only reporting "share
      // as many classes as possible" as a single, weak, lowest-common-denominator suggestion.
      if (constraint.type === 'maximize-shared' && involved.length > 2) {
        for (let i = 0; i < involved.length; i++) {
          for (let j = i + 1; j < involved.length; j++) {
            await suggestFor(constraint, [involved[i]!, involved[j]!]);
          }
        }
      }
    }
  }

  return { friends: friendPlans, sharedSuggestions, warnings };
}
