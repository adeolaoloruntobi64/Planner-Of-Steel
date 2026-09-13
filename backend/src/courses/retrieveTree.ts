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
