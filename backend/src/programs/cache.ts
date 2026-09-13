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

// Program names follow a consistent pattern where the co-op/stream wrapper is the only
// difference from the base program's name (e.g. "SPECIALIST (CO-OPERATIVE) PROGRAM IN COMPUTER
// SCIENCE - Software Engineering Stream" vs "SPECIALIST PROGRAM IN COMPUTER SCIENCE - Software
// Engineering Stream") — stripping that wrapper lets us match a cross-referenced base program
// by name without depending on the LLM's hint text being an exact, resolvable name.
function stripCoopWording(name: string): string {
  return name
    .replace(/\(CO-OPERATIVE\)\s*/gi, '')
    .replace(/\s*-\s*CO-OP(ERATIVE)?\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

/** The expensive step (an LLM call), so this is the one worth caching by far the most. */
export async function getProgramRequirements(campus: Campus, sectionSlug: string, code: string): Promise<ProgramRequirements & { warnings: string[] }> {
  const upperCode = code.toUpperCase();
  const cached = requirementsCache.get(upperCode);
  if (cached) return cached;

  const source = await getProgramRequirementsSource(campus, sectionSlug, upperCode);
  const parsed = await parseProgramRequirements(source);

  let requirements: ProgramRequirements & { warnings: string[] } = parsed;

  // Some programs (typically co-op streams) don't list their own full academic requirements —
  // they point to a base program instead and only list their own extra (e.g. co-op-specific)
  // courses. Left unresolved, the planner would think the co-op variant needs almost nothing
  // beyond those extras, and bury the real gap under a flood of "free elective" filler.
  if (parsed.basedOnProgramHint) {
    try {
      const programs = await getPrograms(campus, sectionSlug);
      const selfStripped = stripCoopWording(source.name);
      const base = programs.find((p) => p.code !== upperCode && stripCoopWording(p.name) === selfStripped);
      if (base) {
        const baseRequirements = await getProgramRequirements(campus, sectionSlug, base.code);
        requirements = {
          ...parsed,
          requiredCourses: [...new Set([...baseRequirements.requiredCourses, ...parsed.requiredCourses])],
          electiveGroups: [...baseRequirements.electiveGroups, ...parsed.electiveGroups],
          warnings: [...baseRequirements.warnings, ...parsed.warnings],
        };
      } else {
        requirements = {
          ...parsed,
          warnings: [
            ...parsed.warnings,
            `${upperCode}'s requirements reference another program ("${parsed.basedOnProgramHint}") that couldn't be matched to a real program in this section — only ${upperCode}'s own listed extras were used, which may be incomplete.`,
          ],
        };
      }
    } catch (err) {
      requirements = {
        ...parsed,
        warnings: [...parsed.warnings, `Could not resolve/merge the base program referenced by ${upperCode}: ${err instanceof Error ? err.message : String(err)}`],
      };
    }
  }

  requirementsCache.set(upperCode, requirements);
  return requirements;
}
