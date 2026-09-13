import Anthropic from '@anthropic-ai/sdk';
import type { ProgramRequirementsSource } from './catalog';
import { listSectionCourseCodes } from './catalog';
import { pushStep } from '../debug/status';

let anthropic: Anthropic | undefined;
function getClient(): Anthropic {
  anthropic ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return anthropic;
}

export interface ElectiveGroup {
  description: string;
  chooseCount: number;
  options: string[];
}

export interface ProgramRequirements {
  code: string;
  name: string;
  requiredCourses: string[];
  electiveGroups: ElectiveGroup[];
  notes?: string;
  /** Set when the requirements text points to another program instead of listing everything
   * itself (e.g. a co-op stream saying "same academic requirements as the Specialist Program
   * in Computer Science" and then only listing its OWN co-op-specific extras). The name/hint
   * as written in the source text — programs/cache.ts resolves it and merges the base
   * program's requirements in; this field survives on the merged result mainly for debugging. */
  basedOnProgramHint?: string;
}

// UofT course codes are always exactly 3 letters (department), an optional A-D year/level
// letter, 2-3 digits, H or Y, and a 1/3/5 campus digit. A model garbling text under a dense
// elective menu tends to prepend/merge stray characters (e.g. "ICSCA48H3" for "CSCA48H3"),
// so this is deliberately strict rather than permissive.
const VALID_CODE_RE = /^[A-Z]{3}[A-D]?\d{2,3}[HY][135]$/;

const EXTRACT_TOOL = {
  name: 'record_program_requirements',
  description: 'Record the course requirements to complete a UofT program, keeping unconditional requirements separate from elective choices.',
  input_schema: {
    type: 'object' as const,
    properties: {
      requiredCourses: {
        type: 'array',
        items: { type: 'string' },
        description:
          'UofT course codes (e.g. "CSCA08H3") that are UNCONDITIONALLY required — every one of these must be taken. ' +
          'Do NOT include courses that are one option among several in a "choose N of..." requirement; those belong in ' +
          'electiveGroups instead. Copy each code exactly as written in the source text — do not paraphrase, merge, or guess at codes.',
      },
      electiveGroups: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            description: { type: 'string', description: 'What this choice is for, e.g. "Breadth requirement: Humanities" or "Choose one AI stream elective".' },
            chooseCount: { type: 'number', description: 'How many courses from options the student must choose.' },
            options: { type: 'array', items: { type: 'string' }, description: 'The UofT course codes available for this choice, copied exactly.' },
          },
          required: ['description', 'chooseCount', 'options'],
        },
        description:
          'Every "choose N of X/Y/Z" style requirement (breadth electives, stream-specific choices, etc.). ' +
          'A large menu of many acceptable courses is an elective group, not a set of individually-required courses.',
      },
      notes: {
        type: 'string',
        description: 'Anything else a course list loses: GPA/grade thresholds, co-op-specific requirements, credit-count minimums, admission-only requirements, etc.',
      },
      basedOnProgramHint: {
        type: 'string',
        description:
          'Set this ONLY if the text says these requirements are the same as, or in addition to, another program\'s ' +
          'requirements (e.g. "Students must complete the program requirements as described in the Specialist Program ' +
          'in Computer Science" — common for co-op streams that only list their co-op-specific extra courses and point ' +
          'to the base non-co-op program for the actual academic course list). Put the referenced program\'s name here ' +
          'exactly as written. Omit entirely if this program\'s own text is a complete, self-contained requirement list.',
      },
    },
    required: ['requiredCourses', 'electiveGroups'],
  },
};

function keepValidCodes(codes: string[], programCode: string, context: string, warnings: string[]): string[] {
  return splitValidCodes(codes, programCode, context, warnings).valid;
}

function splitValidCodes(codes: string[], programCode: string, context: string, warnings: string[]): { valid: string[]; dropped: string[] } {
  const valid: string[] = [];
  const dropped: string[] = [];
  for (const raw of codes) {
    const code = raw.toUpperCase().trim();
    if (VALID_CODE_RE.test(code)) {
      valid.push(code);
    } else {
      dropped.push(raw);
      warnings.push(`Dropped "${raw}" from ${programCode} ${context}: doesn't look like a real UofT course code`);
    }
  }
  return { valid, dropped };
}

const EMBEDDED_CODE_RE = /\b[A-Z]{3}[A-D]?\d{2,3}[HY][135]\b/g;
// Matches compound phrasing like "C- or D-level" as one phrase, not just a single "X-level" —
// captures the whole run of letters/conjunctions before "level" so every level mentioned (not
// just the last one immediately before the word) gets picked up.
const LEVEL_PHRASE_RE = /\b((?:[A-Da-d][\s,-]*(?:or|and)?[\s,-]*)+)level\b/gi;
// Matches a run of bare 3-letter subject codes right before "elective"/"course" (e.g. "CSC,
// MAT, or STA elective") — the OTHER common wildcard shape, alongside a single named subject.
const SUBJECT_LIST_RE = /((?:[A-Z]{3}[\s,]*(?:or|and)?[\s,]*){1,5})(?:elective|course)/gi;

// A handful of subject prefixes this app already deals with directly, mapped to the calendar
// section that actually lists their courses — needed because a multi-department wildcard (e.g.
// "CSC, MAT, or STA elective") can name subjects outside the CURRENT program's own section, and
// that other section's course list isn't necessarily linked from this program's page at all.
// Deliberately small: only subjects we can name with confidence, not a guessed general mapping.
const KNOWN_SECTION_BY_PREFIX: Record<string, string> = {
  CSC: 'Computer-Science',
  MAT: 'Mathematics',
  STA: 'Statistics',
};

/**
 * An elective description like "Any C- or D-level STA course (excluding STAC32H3, STAC53H3,
 * STAD29H3)" — or "CSC, MAT, or STA elective (C- or D-level)" — isn't a course code at all, so
 * keepValidCodes correctly drops it, but dropping it outright throws away a real, resolvable
 * requirement instead of just an unparseable one. This turns that kind of wildcard wording into
 * the actual matching course codes by cross-referencing each mentioned subject's real course
 * list (see listSectionCourseCodes), rather than guessing or asking the model to recall UofT's
 * calendar from memory. Not subject-specific: works for any department this can find a course
 * list for, though it's most reliable for CSC/MAT/STA (see KNOWN_SECTION_BY_PREFIX) since a
 * wildcard naming a subject with no mapped section falls back to the CURRENT program's own
 * section page, which may not comprehensively list a THIRD-PARTY department's courses.
 */
async function resolveWildcardOptions(
  source: ProgramRequirementsSource,
  description: string,
  droppedTexts: string[],
  alreadyValid: string[],
  warnings: string[]
): Promise<string[]> {
  if (droppedTexts.length === 0) return [];
  const combined = [description, ...droppedTexts].join(' ; ');

  const levelPhrases = [...combined.matchAll(LEVEL_PHRASE_RE)].map((m) => m[1]!);
  const levels = new Set(levelPhrases.flatMap((phrase) => phrase.match(/[A-Da-d]/g) ?? []).map((l) => l.toUpperCase()));
  if (levels.size === 0) return []; // nothing here looks like a "any X-level ... course" wildcard

  const mentionedCodes = [...new Set([...combined.matchAll(EMBEDDED_CODE_RE)].map((m) => m[0].toUpperCase()))];
  const excluded = new Set([...mentionedCodes, ...alreadyValid]); // "excluding X, Y" codes, plus anything already resolved normally

  // Prefixes can come from either shape: codes embedded in the text (single-subject wildcards
  // usually mention their own exclusions this way) or a bare subject list right before
  // "elective"/"course" (multi-subject wildcards, e.g. "CSC, MAT, or STA elective").
  const subjectListPrefixes = [...combined.matchAll(SUBJECT_LIST_RE)].flatMap((m) => m[1]!.match(/[A-Z]{3}/g) ?? []);
  const prefixes = [...new Set([...mentionedCodes.map((c) => c.slice(0, 3)), ...subjectListPrefixes])];
  if (prefixes.length === 0) return []; // no subject anywhere nearby to infer from — too ambiguous to guess

  try {
    const sectionCodesByPrefix = new Map<string, string[]>();
    await Promise.all(
      prefixes.map(async (prefix) => {
        const sectionSlug = KNOWN_SECTION_BY_PREFIX[prefix] ?? source.sectionSlug;
        sectionCodesByPrefix.set(prefix, await listSectionCourseCodes(source.campus, sectionSlug));
      })
    );

    const matches = prefixes.flatMap((prefix) =>
      (sectionCodesByPrefix.get(prefix) ?? []).filter((code) => {
        if (!code.startsWith(prefix) || excluded.has(code)) return false;
        const level = code.charAt(3);
        return /[A-D]/.test(level) && levels.has(level);
      })
    );
    if (matches.length === 0) {
      warnings.push(`Could not resolve wildcard elective wording ("${combined}") to any real course — the relevant section page(s) may not list every matching course.`);
    }
    return matches;
  } catch (err) {
    warnings.push(`Could not resolve wildcard elective wording ("${combined}"): ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Program requirement text is free-form prose (streams, electives, co-op options) that
 * varies too much per program for a reliable regex — unlike course prerequisite text,
 * which is short and formulaic enough for extractCodes(). Getting a program's course list
 * wrong would break an entire plan, so this is worth the LLM call. Cache the result (see
 * programs/cache.ts) so it's a one-time cost per program, not a per-plan cost.
 *
 * Large elective/breadth menus (e.g. "choose 2 of these 15 humanities courses") are kept as
 * electiveGroups rather than flattened into requiredCourses — real testing showed flattening
 * makes the planner think dozens of optional courses are all mandatory. Codes are also
 * validated against UofT's course-code shape and dropped (with a warning) if they don't
 * match, since dense elective menus are where the model is most prone to garbling a code.
 */
export async function parseProgramRequirements(source: ProgramRequirementsSource): Promise<ProgramRequirements & { warnings: string[] }> {
  const done = pushStep(`Parsing program requirements for ${source.code} (Claude)`);
  try {
    const response = await getClient().messages.create({
      model: process.env.MODEL_NAME ?? 'claude-haiku-4-5',
      max_tokens: 4096,
      system:
        'You extract structured course requirements from University of Toronto program calendar entries. ' +
        'Distinguish courses that are unconditionally required from courses that are one option within a choice ' +
        '(elective menus, breadth requirements, stream-specific options). Use the record_program_requirements tool ' +
        'to report your findings, copying course codes exactly as they appear in the source text.',
      messages: [
        {
          role: 'user',
          content: `Program: ${source.name} (${source.code})\n\nRequirements text:\n${source.requirementsHtml}`,
        },
      ],
      tools: [EXTRACT_TOOL],
      tool_choice: { type: 'tool', name: EXTRACT_TOOL.name },
    });

    const toolUse = response.content.find((block) => block.type === 'tool_use');
    if (!toolUse || toolUse.type !== 'tool_use') {
      throw new Error('Model did not return structured program requirements');
    }

    const result = toolUse.input as {
      requiredCourses: string[];
      electiveGroups: { description: string; chooseCount: number; options: string[] }[];
      notes?: string;
      basedOnProgramHint?: string;
    };

    const warnings: string[] = [];
    const requiredCourses = [...new Set(keepValidCodes(result.requiredCourses, source.code, 'requiredCourses', warnings))];
    const electiveGroups = await Promise.all(
      result.electiveGroups.map(async (g) => {
        const { valid, dropped } = splitValidCodes(g.options, source.code, `elective group "${g.description}"`, warnings);
        const wildcardMatches = await resolveWildcardOptions(source, g.description, dropped, valid, warnings);
        return {
          description: g.description,
          chooseCount: g.chooseCount,
          options: [...new Set([...valid, ...wildcardMatches])],
        };
      })
    );
    const nonEmptyGroups = electiveGroups.filter((g) => g.options.length > 0);

    return {
      code: source.code,
      name: source.name,
      requiredCourses,
      electiveGroups: nonEmptyGroups,
      warnings,
      ...(result.notes && { notes: result.notes }),
      ...(result.basedOnProgramHint && { basedOnProgramHint: result.basedOnProgramHint }),
    };
  } finally {
    done();
  }
}
