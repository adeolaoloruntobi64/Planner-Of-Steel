import { getCourseInfo } from './cache';

const CODE_RE = /\b[A-Z]{3,4}\d{2,3}[HY][135]\b/g;

export function extractCodes(text: string | undefined): string[] {
  if (!text) return [];
  return [...new Set((text.match(CODE_RE) ?? []).map((c) => c.toUpperCase()))];
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
  prereqCourses: string[];
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
  const prereqCourses = extractCodes(info.prerequisite);
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
    prereqCourses,
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
