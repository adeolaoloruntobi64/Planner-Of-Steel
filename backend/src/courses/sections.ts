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

/**
 * Picks one section per section-type (LEC/TUT/PRA/...) per course, favoring the given time
 * preference and, by default, avoiding time conflicts with sections already chosen earlier
 * in the list. When allowConflicts is true, the best-preference section is always kept even
 * if it conflicts — conflicts are reported on the result rather than avoided.
 *
 * This is a greedy, course-order-dependent choice rather than an exhaustive search over every
 * combination — fine at the course-load sizes a single semester actually has, and keeps the
 * algorithm simple and explainable.
 */
export function chooseSections(
  courses: CourseSectionGroup[],
  options: { timePreference?: TimePreference | undefined; allowConflicts?: boolean | undefined } = {}
): SelectionResult {
  const chosen: ChosenSection[] = [];
  let hasUnresolvedConflicts = false;

  for (const course of courses) {
    const byType = new Map<string, CourseSection[]>();
    for (const section of course.sections) {
      const list = byType.get(section.type) ?? [];
      list.push(section);
      byType.set(section.type, list);
    }

    for (const [, candidates] of byType) {
      const scored = candidates.map((section) => {
        const slots = slotsFor(section.meetings);
        const conflictsWith = chosen.filter((c) => slotsConflict(slots, slotsFor(c.section.meetings)));
        return { section, slots, conflictsWith, score: preferenceScore(slots, options.timePreference) };
      });

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
        courseCode: course.code,
        section: best.section,
        conflictsWith: best.conflictsWith.map((c) => ({ courseCode: c.courseCode, sectionCode: c.section.code })),
      });
    }
  }

  return { chosen, hasUnresolvedConflicts };
}
