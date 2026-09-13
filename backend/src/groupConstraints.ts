import Anthropic from '@anthropic-ai/sdk';
import { pushStep } from './debug/status';

let anthropic: Anthropic | undefined;
function getClient(): Anthropic {
  anthropic ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return anthropic;
}

export interface TakeTogetherConstraint {
  type: 'take-together';
  friendNames: string[];
  /** A specific course code or topic/keyword the student mentioned (e.g. "CSCC85H3" or "a robotics course"), if any. */
  courseHint?: string;
}

export interface MaximizeSharedConstraint {
  type: 'maximize-shared';
  friendNames: string[];
  /** Freeform hint about which point in the plan this applies to (e.g. "3rd year fall"), if any. */
  timeframeHint?: string;
  /** Year of study (1-4) this applies to, if the request named one (e.g. "3rd year" -> 3), so
   * candidates can actually be restricted to that year's semesters instead of just noted. */
  targetYear?: number;
}

export type GroupConstraint = TakeTogetherConstraint | MaximizeSharedConstraint;

const PARSE_TOOL = {
  name: 'record_group_constraints',
  description: 'Record the structured scheduling constraints extracted from a freeform group-planning request.',
  input_schema: {
    type: 'object' as const,
    properties: {
      constraints: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['take-together', 'maximize-shared'],
              description:
                '"take-together": specific friends want to be in the same course at the same time. ' +
                '"maximize-shared": friends want as much overlap as possible in their schedules generally, or in some part of it.',
            },
            friendNames: {
              type: 'array',
              items: { type: 'string' },
              description: 'Which of the given friend names this constraint applies to. Use the exact names given, at least 2.',
            },
            courseHint: {
              type: 'string',
              description: 'For take-together only: a specific course code or topic/keyword mentioned, if any.',
            },
            timeframeHint: {
              type: 'string',
              description: 'For maximize-shared only: freeform hint about which point in the plan this applies to (e.g. "3rd year fall"), if any.',
            },
            targetYear: {
              type: 'number',
              description: 'For maximize-shared only: the year of study (1-4) this applies to, if a specific one was named (e.g. "3rd year" -> 3, "in our final year" -> 4). Omit if no specific year was named.',
            },
          },
          required: ['type', 'friendNames'],
        },
      },
    },
    required: ['constraints'],
  },
};

/**
 * Turns a freeform group-planning request ("2 of us want to take a course together", "we want
 * to maximize overlap in 3rd year fall") into structured constraints buildGroupPlan can act on.
 * Falls back to no constraints on any failure — a group plan with no special constraints (just
 * each friend's own independent plan) is still a useful result, so this never blocks planning.
 */
export async function parseGroupConstraints(prompt: string, friendNames: string[]): Promise<GroupConstraint[]> {
  const done = pushStep('Parsing group scheduling constraints (Claude)');
  try {
    const response = await getClient().messages.create({
      model: process.env.MODEL_NAME ?? 'claude-haiku-4-5',
      max_tokens: 1024,
      system: 'You extract structured scheduling constraints from a freeform group course-planning request. Use the record_group_constraints tool to report your findings.',
      messages: [
        {
          role: 'user',
          content: `Friends in this group: ${friendNames.join(', ')}\n\nRequest: "${prompt}"`,
        },
      ],
      tools: [PARSE_TOOL],
      tool_choice: { type: 'tool', name: PARSE_TOOL.name },
    });

    const toolUse = response.content.find((block) => block.type === 'tool_use');
    if (!toolUse || toolUse.type !== 'tool_use') return [];

    const { constraints } = toolUse.input as { constraints: GroupConstraint[] };
    const nameSet = new Set(friendNames.map((n) => n.toLowerCase()));
    return constraints
      .map((c) => ({ ...c, friendNames: c.friendNames.filter((n) => nameSet.has(n.toLowerCase())) }))
      .filter((c) => c.friendNames.length >= 2);
  } catch {
    return [];
  } finally {
    done();
  }
}
