import type { Campus } from '../courses/calendar';
import { listProgramSections, listPrograms, getProgramRequirementsSource, type ProgramSection, type ProgramSummary } from './catalog';
import { parseProgramRequirements, type ProgramRequirements } from './requirements';

const sectionsCache = new Map<Campus, ProgramSection[]>();
const programsCache = new Map<string, ProgramSummary[]>(); // key: `${campus}/${sectionSlug}`
const requirementsCache = new Map<string, ProgramRequirements & { warnings: string[] }>(); // key: program code

export async function getProgramSections(campus: Campus): Promise<ProgramSection[]> {
  const cached = sectionsCache.get(campus);
  if (cached) return cached;
  const sections = await listProgramSections(campus);
  sectionsCache.set(campus, sections);
  return sections;
}

export async function getPrograms(campus: Campus, sectionSlug: string): Promise<ProgramSummary[]> {
  const key = `${campus}/${sectionSlug}`;
  const cached = programsCache.get(key);
  if (cached) return cached;
  const programs = await listPrograms(campus, sectionSlug);
  programsCache.set(key, programs);
  return programs;
}

/** The expensive step (an LLM call), so this is the one worth caching by far the most. */
export async function getProgramRequirements(campus: Campus, sectionSlug: string, code: string): Promise<ProgramRequirements & { warnings: string[] }> {
  const upperCode = code.toUpperCase();
  const cached = requirementsCache.get(upperCode);
  if (cached) return cached;

  const source = await getProgramRequirementsSource(campus, sectionSlug, upperCode);
  const requirements = await parseProgramRequirements(source);
  requirementsCache.set(upperCode, requirements);
  return requirements;
}
