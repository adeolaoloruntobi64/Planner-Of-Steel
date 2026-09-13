import Anthropic from '@anthropic-ai/sdk';
import type { ProgramRequirementsSource } from './catalog';
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
    },
    required: ['requiredCourses', 'electiveGroups'],
  },
};

function keepValidCodes(codes: string[], programCode: string, context: string, warnings: string[]): string[] {
  const valid: string[] = [];
  for (const raw of codes) {
    const code = raw.toUpperCase().trim();
    if (VALID_CODE_RE.test(code)) {
      valid.push(code);
    } else {
      warnings.push(`Dropped "${raw}" from ${programCode} ${context}: doesn't look like a real UofT course code`);
    }
  }
  return valid;
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
    };

    const warnings: string[] = [];
    const requiredCourses = [...new Set(keepValidCodes(result.requiredCourses, source.code, 'requiredCourses', warnings))];
    const electiveGroups = result.electiveGroups
      .map((g) => ({
        description: g.description,
        chooseCount: g.chooseCount,
        options: [...new Set(keepValidCodes(g.options, source.code, `elective group "${g.description}"`, warnings))],
      }))
      .filter((g) => g.options.length > 0);

    return {
      code: source.code,
      name: source.name,
      requiredCourses,
      electiveGroups,
      warnings,
      ...(result.notes && { notes: result.notes }),
    };
  } finally {
    done();
  }
}
