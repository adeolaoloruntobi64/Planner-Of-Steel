import { getCourseInfo } from './cache';

const CODE_RE = /\b[A-Z]{3,4}\d{2,3}[HY][135]\b/g;

export function extractCodes(text: string | undefined): string[] {
  if (!text) return [];
  return [...new Set((text.match(CODE_RE) ?? []).map((c) => c.toUpperCase()))];
}

/**
 * Splits on the word "and", but only occurrences OUTSIDE any [...] bracket — UofT prereq text
 * nests brackets (e.g. "[MATA22H3 or MATA23H3] and [[MATA36H3 or MATA37H3] or [MAT137H5 and
 * MAT139H5] or [MAT157H5 and MAT159H5]]"), and a naive split on every "and" would break inside
 * that nested "[MAT137H5 and MAT139H5]" OR-alternative too, turning it into its own mandatory
 * AND-group and permanently blocking the course on an unrelated cross-campus equivalency path.
 */
function splitTopLevelAnd(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let last = 0;
  const tokenRe = /\[|\]|\band\b/gi;
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(text))) {
    if (match[0] === '[') depth++;
    else if (match[0] === ']') depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      parts.push(text.slice(last, match.index));
      last = match.index + match[0].length;
    }
  }
  parts.push(text.slice(last));
  return parts;
}

/**
 * UofT prerequisite text joins separate AND-requirements with the literal word "and"
 * (e.g. "CSCB09H3 and CSCB63H3 and [CGPA of at least 3.5 or ...]"), while codes within a
 * single clause (joined by "/", ",", "or", or nested further) are treated as OR-alternatives
 * — a deliberate simplification for nested AND-within-OR sub-clauses (rare cross-campus
 * equivalency paths), since being too permissive there is far safer than the alternative of
 * incorrectly hard-blocking the course's normal path. Clauses with no real course code
 * (GPA/POSt conditions we can't verify) drop out entirely.
 */
export function parsePrereqGroups(text: string | undefined): string[][] {
  if (!text) return [];
  const groups: string[][] = [];
  for (const clause of splitTopLevelAnd(text)) {
    const codes = extractCodes(clause);
    if (codes.length > 0) groups.push(codes);
  }
  return groups;
}

// Some prerequisites are a standing/credit threshold with NO course code at all (e.g. "14.0
// credits and enrolment in a Computer Science Subject POSt" — a real UofT D-level course's
// entire prerequisite). parsePrereqGroups correctly drops that clause (there's no course to
// check), but that used to mean the course looked entirely prereq-free — vacuously true on an
// empty AND-of-OR check — letting a 4th-year-only course get scheduled in semester 1. Extracted
// separately so callers can check it against the student's accumulated credits directly.
// Requires >=1 credit so an incidental "0.5 credit" (a course's own weight, not a threshold
// being described) doesn't get misread as one.
const CREDIT_THRESHOLD_RE = /(\d+(?:\.\d+)?)\s*credits?\b/i;

function extractMinCredits(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const value = parseFloat(text.match(CREDIT_THRESHOLD_RE)?.[1] ?? '');
  return Number.isFinite(value) && value >= 1 ? value : undefined;
}

// A UofT course code's own level letter (the 4th character, when present) already encodes
// roughly how far into the degree it belongs — independent of whether we can parse the
// specific restriction text at all. Some restrictions are genuinely unparseable as a number
// (e.g. "4th year standing", or nothing numeric at all) but the level letter is always right
// there in the code. Used as a FLOOR (combined with any explicitly parsed credit threshold via
// max()), not a replacement — a real, more specific threshold always still applies too.
const LEVEL_FLOOR_CREDITS: Record<string, number> = { A: 0, B: 4, C: 9, D: 14 };

// Co-op administrative courses (COPB50H3, COPC01H3, ...) don't follow the normal A-D
// year-level convention at all — the letter there means something else entirely (prep-course
// stage / work-term number), not "how many credits before you can take this". A first-year
// co-op prep course would otherwise get a bogus B-level credit floor imposed on it.
const NON_STANDARD_LEVEL_PREFIX_RE = /^COP/;

function levelFloorCredits(code: string): number {
  if (NON_STANDARD_LEVEL_PREFIX_RE.test(code)) return 0;
  return LEVEL_FLOOR_CREDITS[code.charAt(3)] ?? 0;
}

// Independent-study / directed-reading / project courses ("Readings in X", "X Project") are
// typically gated on "consent of the instructor/supervisor" rather than any course or credit
// threshold at all — something this planner has no way to verify or arrange on the student's
// behalf (it requires actually finding a supervisor and proposing a project). These should
// never be auto-picked as elective/breadth/interest filler; see planner.ts's isAutomaticallySchedulable.
const REQUIRES_PERMISSION_RE = /\bconsent\b|\bpermission\s+(of|from)\b/i;

export interface CourseNode {
  code: string;
  title: string;
  description?: string;
  prerequisiteText?: string;
  corequisiteText?: string;
  breadthRequirement?: string;
  recommendedPreparation?: string;
  excludes: string[];
  /** AND-of-OR structure: every group must have at least one satisfied code. */
  prereqGroups: string[][];
  /** A standing/credit-count threshold mentioned in the prerequisite text (e.g. 14.0), if any —
   * separate from prereqGroups since it's checked against total credits, not a course code.
   * Always at least the course's own level-letter floor (see levelFloorCredits), even when the
   * text itself has no parseable number. */
  minCreditsRequired?: number;
  /** True if the prerequisite text requires instructor/supervisor consent — an independent
   * study or project course this planner can't verify or arrange, so it shouldn't be
   * auto-picked as filler (see planner.ts's isAutomaticallySchedulable). */
  requiresPermission?: boolean;
  coreqCourses: string[];
  children: CourseNode[];
  /** Prereq codes not expanded further: cycle back to an ancestor, past maxDepth, or failed to fetch. */
  truncated: string[];
}

const treeMemo = new Map<string, CourseNode>();

export function clearTreeMemo(): void {
  treeMemo.clear();
}

export async function retrieveTree(code: string, maxDepth = 6): Promise<CourseNode> {
  return buildNode(code.toUpperCase(), [], maxDepth);
}

async function buildNode(code: string, ancestors: string[], maxDepth: number): Promise<CourseNode> {
  const cached = treeMemo.get(code);
  if (cached) return cached;

  const info = await getCourseInfo(code);
  const prereqGroups = parsePrereqGroups(info.prerequisite);
  const prereqCourses = [...new Set(prereqGroups.flat())];
  const coreqCourses = extractCodes(info.corequisite);
  const excludes = extractCodes(info.exclusion);
  const minCreditsRequired = Math.max(extractMinCredits(info.prerequisite) ?? 0, levelFloorCredits(code)) || undefined;
  const requiresPermission = REQUIRES_PERMISSION_RE.test(info.prerequisite ?? '');

  const node: CourseNode = {
    code: info.code,
    title: info.title,
    ...(info.description && { description: info.description }),
    ...(info.prerequisite && { prerequisiteText: info.prerequisite }),
    ...(info.corequisite && { corequisiteText: info.corequisite }),
    ...(info.breadthRequirement && { breadthRequirement: info.breadthRequirement }),
    ...(info.recommendedPreparation && { recommendedPreparation: info.recommendedPreparation }),
    excludes,
    prereqGroups,
    ...(minCreditsRequired !== undefined && { minCreditsRequired }),
    ...(requiresPermission && { requiresPermission }),
    coreqCourses,
    children: [],
    truncated: [],
  };

  // Set before recursing so a cycle back to this node hits the memo instead of looping.
  treeMemo.set(code, node);

  const nextAncestors = [...ancestors, code];
  for (const childCode of prereqCourses) {
    if (childCode === code) continue;
    if (nextAncestors.includes(childCode) || nextAncestors.length >= maxDepth) {
      node.truncated.push(childCode);
      continue;
    }
    try {
      const childNode = await buildNode(childCode, nextAncestors, maxDepth);
      node.children.push(childNode);
    } catch {
      node.truncated.push(childCode);
    }
  }

  return node;
}
