export type Campus = 'stgeorge' | 'utsc' | 'utm';
export type Session = 'F' | 'S' | 'Y';

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

export interface CourseOption {
  code: string;
  title: string;
}

export interface ParsedTranscript {
  completedCourses: string[];
  inProgressCourses: string[];
  semestersElapsed: number;
  nextSession: 'F' | 'S';
  program: string;
  notes?: string;
}

export interface PlacedCourseSection {
  code: string;
  type: string;
  conflictsWith: string[];
}

export type PlacementCategory = 'required' | 'elective' | 'breadth' | 'interest' | 'free-elective';

export interface PlacedCourse {
  code: string;
  title: string;
  credit: number;
  category: PlacementCategory;
  session?: Session;
  sections?: PlacedCourseSection[];
}

export interface SemesterPlan {
  index: number;
  session: Session;
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

export function getProgramCourses(campus: Campus, sectionSlug: string, programCode: string): Promise<CourseOption[]> {
  return api(`/programs/${campus}/sections/${encodeURIComponent(sectionSlug)}/${encodeURIComponent(programCode)}/courses`);
}

export function parseTranscript(transcriptText: string, prompt?: string): Promise<ParsedTranscript> {
  return api('/degree-planner/transcript', {
    method: 'POST',
    body: JSON.stringify({ transcriptText, prompt }),
  });
}

export async function uploadTranscriptFile(file: File, prompt?: string): Promise<ParsedTranscript> {
  const formData = new FormData();
  formData.append('file', file);
  if (prompt) formData.append('prompt', prompt);

  const res = await fetch('/api/degree-planner/transcript/upload', { method: 'POST', body: formData });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(body.error ?? `Upload failed with ${res.status}`);
  }
  return body as ParsedTranscript;
}

export interface ProgramSelector {
  campus: Campus;
  sectionSlug: string;
  programCode: string;
}

export interface BuildPlanInput {
  completedCourses: string[];
  inProgressCourses?: string[];
  programs: ProgramSelector[];
  /** Omit to plan every remaining semester until the program(s) are complete. */
  semesters?: number;
  semestersElapsed?: number;
  startSession?: 'F' | 'S';
  interests?: string;
}

export function buildPlan(input: BuildPlanInput): Promise<DegreePlan> {
  return api('/plan', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export interface FriendInput {
  name: string;
  completedCourses: string[];
  inProgressCourses?: string[];
  programs: ProgramSelector[];
  semestersElapsed?: number;
  startSession?: 'F' | 'S';
  interests?: string;
}

export interface SharedSuggestion {
  constraintType: 'take-together' | 'maximize-shared';
  friendNames: string[];
  code: string;
  title: string;
  friendSemesters: { name: string; semesterIndex: number }[];
  note: string;
}

export interface GroupPlan {
  friends: { name: string; plan: DegreePlan }[];
  sharedSuggestions: SharedSuggestion[];
  warnings: string[];
}

export interface BuildGroupPlanInput {
  friends: FriendInput[];
  constraintsPrompt?: string;
  semesters?: number;
}

export function buildGroupPlan(input: BuildGroupPlanInput): Promise<GroupPlan> {
  return api('/group-plan', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}
