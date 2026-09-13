export type Campus = 'stgeorge' | 'utsc' | 'utm';
export type Session = 'F' | 'S' | 'Y';
export type TimePreference = 'morning' | 'afternoon' | 'evening' | 'none';

export interface ProgramSection {
  name: string;
  slug: string;
  url: string;
}

export interface ProgramSummary {
  code: string;
  name: string;
  campus: Campus;
  sectionSlug: string;
}

export interface ParsedTranscript {
  completedCourses: string[];
  program: string;
  notes?: string;
}

export interface PlacedCourseSection {
  code: string;
  type: string;
  conflictsWith: string[];
}

export interface PlacedCourse {
  code: string;
  title: string;
  credit: number;
  session?: Session;
  sections?: PlacedCourseSection[];
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

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(body.error ?? `Request to ${path} failed with ${res.status}`);
  }
  return body as T;
}

export function getProgramSections(campus: Campus): Promise<ProgramSection[]> {
  return api(`/programs/${campus}/sections`);
}

export function getPrograms(campus: Campus, sectionSlug: string): Promise<ProgramSummary[]> {
  return api(`/programs/${campus}/sections/${encodeURIComponent(sectionSlug)}`);
}

export function parseTranscript(transcriptText: string, prompt?: string): Promise<ParsedTranscript> {
  return api('/degree-planner/transcript', {
    method: 'POST',
    body: JSON.stringify({ transcriptText, prompt }),
  });
}

export interface ProgramSelector {
  campus: Campus;
  sectionSlug: string;
  programCode: string;
}

export interface BuildPlanInput {
  completedCourses: string[];
  programs: ProgramSelector[];
  /** Omit to plan every remaining semester until the program(s) are complete. */
  semesters?: number;
  timePreference?: TimePreference;
  allowConflicts?: boolean;
}

export function buildPlan(input: BuildPlanInput): Promise<DegreePlan> {
  return api('/plan', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}
