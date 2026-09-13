import type { CourseSection, SectionMeeting } from './ttb';

export type TimePreference = 'morning' | 'afternoon' | 'evening' | 'none';

export interface TimeSlot {
  day: string;
  startMinutes: number;
  endMinutes: number;
}

export function toMinutes(time: string): number | undefined {
  const match = time.match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!match) return undefined;
  const [, h, min, ap] = match;
  let hour = parseInt(h!, 10) % 12;
  if (ap!.toUpperCase() === 'PM') hour += 12;
  return hour * 60 + parseInt(min!, 10);
}

export function slotsFor(meetings: SectionMeeting[]): TimeSlot[] {
  const slots: TimeSlot[] = [];
  for (const m of meetings) {
    const start = toMinutes(m.start);
    const end = toMinutes(m.end);
    if (start === undefined || end === undefined) continue;
    slots.push({ day: m.day, startMinutes: start, endMinutes: end });
  }
  return slots;
}

export function slotsConflict(a: TimeSlot[], b: TimeSlot[]): boolean {
  return a.some((s1) => b.some((s2) => s1.day === s2.day && s1.startMinutes < s2.endMinutes && s2.startMinutes < s1.endMinutes));
}

/** Higher is better. Scores how well a set of slots matches a stated time preference. */
export function preferenceScore(slots: TimeSlot[], preference: TimePreference | undefined): number {
  if (!preference || preference === 'none' || slots.length === 0) return 0;
  const avgStart = slots.reduce((sum, s) => sum + s.startMinutes, 0) / slots.length;
  const NOON = 12 * 60;
  const EVENING_TARGET = 18 * 60;
  if (preference === 'morning') return -avgStart;
  if (preference === 'afternoon') return -Math.abs(avgStart - NOON);
  return -Math.abs(avgStart - EVENING_TARGET); // evening
}

export interface CourseSectionGroup {
  code: string;
  sections: CourseSection[];
}

export interface ChosenSection {
  courseCode: string;
  section: CourseSection;
  conflictsWith: { courseCode: string; sectionCode: string }[];
}

export interface SelectionResult {
  chosen: ChosenSection[];
  hasUnresolvedConflicts: boolean;
}

interface Slot {
  courseCode: string;
  type: string;
  candidates: { section: CourseSection; slots: TimeSlot[]; score: number }[];
}

function buildSlots(courses: CourseSectionGroup[], timePreference: TimePreference | undefined): Slot[] {
  const slots: Slot[] = [];
  for (const course of courses) {
    const byType = new Map<string, CourseSection[]>();
    for (const section of course.sections) {
      const list = byType.get(section.type) ?? [];
      list.push(section);
      byType.set(section.type, list);
    }
    for (const [type, sections] of byType) {
      const candidates = sections
        .map((section) => {
          const slotsForSection = slotsFor(section.meetings);
          return { section, slots: slotsForSection, score: preferenceScore(slotsForSection, timePreference) };
        })
        .sort((a, b) => b.score - a.score); // most-preferred first, so backtracking/greedy both try the best option first
      slots.push({ courseCode: course.code, type, candidates });
    }
  }
  return slots;
}

// Bound on how many assignment attempts the exhaustive search below will try before giving up
// and falling back to the greedy, order-dependent choice. A real semester's course load is
// small (a handful of courses, a few sections each) so this is never actually approached in
// practice — it just protects against a pathological input blowing up combinatorially.
const MAX_BACKTRACK_STEPS = 200_000;

/**
 * Exhaustively searches for a full assignment (one section per type per course) with ZERO time
 * conflicts, trying each slot's most-preferred candidates first so that among multiple
 * conflict-free solutions it favors the one closest to the stated time preference. Returns null
 * if no fully conflict-free assignment exists (or the search is aborted at the step cap).
 */
function findConflictFreeAssignment(slots: Slot[]): Map<Slot, number> | null {
  const chosenIndex = new Map<Slot, number>();
  const chosenSlots: TimeSlot[][] = [];
  let steps = 0;

  function backtrack(i: number): boolean {
    if (i === slots.length) return true;
    const slot = slots[i]!;
    for (let c = 0; c < slot.candidates.length; c++) {
      if (++steps > MAX_BACKTRACK_STEPS) return false;
      const candidate = slot.candidates[c]!;
      if (chosenSlots.some((existing) => slotsConflict(candidate.slots, existing))) continue;
      chosenIndex.set(slot, c);
      chosenSlots.push(candidate.slots);
      if (backtrack(i + 1)) return true;
      chosenSlots.pop();
      chosenIndex.delete(slot);
    }
    return false;
  }

  return backtrack(0) ? chosenIndex : null;
}

/**
 * Picks one section per section-type (LEC/TUT/PRA/...) per course, favoring the given time
 * preference. By default, this first tries to find a FULL, genuinely conflict-free assignment
 * across every course/section-type at once (not just avoiding conflicts with whatever was
 * already picked earlier in the list) — a naive greedy, course-order-dependent pick can report
 * "no conflict-free combination" when a valid one actually exists, just not reachable by
 * committing to courses one at a time in scrape order. Only when no complete conflict-free
 * assignment exists at all (or allowConflicts is set) does it fall back to the greedy,
 * minimize-conflicts choice and report the unavoidable conflicts on the result.
 */
export function chooseSections(
  courses: CourseSectionGroup[],
  options: { timePreference?: TimePreference | undefined; allowConflicts?: boolean | undefined } = {}
): SelectionResult {
  const slots = buildSlots(courses, options.timePreference);

  if (!options.allowConflicts) {
    const assignment = findConflictFreeAssignment(slots);
    if (assignment) {
      const chosen: ChosenSection[] = slots.map((slot) => ({
        courseCode: slot.courseCode,
        section: slot.candidates[assignment.get(slot)!]!.section,
        conflictsWith: [],
      }));
      return { chosen, hasUnresolvedConflicts: false };
    }
  }

  // Fallback: no complete conflict-free assignment exists (or conflicts are allowed) — greedily
  // take each slot's best-scoring, least-conflicting-with-what's-chosen-so-far option and report
  // whatever conflicts remain.
  const chosen: ChosenSection[] = [];
  let hasUnresolvedConflicts = false;

  for (const slot of slots) {
    const scored = slot.candidates.map((candidate) => ({
      ...candidate,
      conflictsWith: chosen.filter((c) => slotsConflict(candidate.slots, slotsFor(c.section.meetings))),
    }));

    scored.sort((a, b) => {
      if (!options.allowConflicts && a.conflictsWith.length !== b.conflictsWith.length) {
        return a.conflictsWith.length - b.conflictsWith.length;
      }
      return b.score - a.score;
    });

    const best = scored[0];
    if (!best) continue;
    if (best.conflictsWith.length > 0) hasUnresolvedConflicts = true;

    chosen.push({
      courseCode: slot.courseCode,
      section: best.section,
      conflictsWith: best.conflictsWith.map((c) => ({ courseCode: c.courseCode, sectionCode: c.section.code })),
    });
  }

  return { chosen, hasUnresolvedConflicts };
}
