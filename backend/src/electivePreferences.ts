import Anthropic from '@anthropic-ai/sdk';
import { pushStep } from './debug/status';

let anthropic: Anthropic | undefined;
function getClient(): Anthropic {
  anthropic ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return anthropic;
}

const RANK_TOOL = {
  name: 'record_rankings',
  description: 'Record one best-fit-to-worst-fit ranking of the given course codes PER distinct interest identified.',
  input_schema: {
    type: 'object' as const,
    properties: {
      rankingsByInterest: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            interest: {
              type: 'string',
              description: 'The specific interest this ranking is for, or "broad/well-rounded" if the student stated no specific interest.',
            },
            rankedCodes: {
              type: 'array',
              items: { type: 'string' },
              description: 'Every one of the given course codes, reordered best-fit-for-THIS-interest first. Must include each code exactly once.',
            },
          },
          required: ['interest', 'rankedCodes'],
        },
        description:
          'One entry per DISTINCT interest the student mentioned — split them apart even if phrased as one sentence ' +
          '(e.g. "robotics and cybersecurity" is TWO entries, each ranked independently for that interest alone, not ' +
          'blended into a single compromise order). If the student stated no specific interest, exactly one entry for ' +
          'a broad/well-rounded ranking.',
      },
    },
    required: ['rankingsByInterest'],
  },
};

/** Round-robins across each interest's own ranking (best-of-interest-1, best-of-interest-2, ..., then second-best of
 * each, ...) so every stated interest is guaranteed representation near the top of the combined order, instead of
 * depending on a single blended ranking call to not let one interest crowd out another. */
function interleaveRankings(rankings: string[][]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  const maxLen = Math.max(0, ...rankings.map((r) => r.length));
  for (let i = 0; i < maxLen; i++) {
    for (const ranking of rankings) {
      const code = ranking[i];
      if (code && !seen.has(code)) {
        result.push(code);
        seen.add(code);
      }
    }
  }
  return result;
}

/**
 * Ranks an elective group's options by fit to the student's stated interest(s) (e.g.
 * "cybersecurity", or "robotics and cybersecurity"), or by broad/well-rounded usefulness if no
 * interest was given — so when the planner only needs to fill 1-2 of many options, it picks the
 * ones that actually match what the student wants instead of whatever happened to come first in
 * the scraped list. When multiple interests are stated, Claude ranks each one SEPARATELY and the
 * results are interleaved in code — a guarantee that every stated interest gets a shot near the
 * top, rather than trusting one blended ranking not to let a single interest dominate.
 * Falls back to the original order on any failure (never blocks planning on this).
 */
export async function rankElectiveOptions(
  description: string,
  options: { code: string; title: string }[],
  interest: string | undefined
): Promise<string[]> {
  const codes = options.map((o) => o.code);
  if (options.length <= 1) return codes;

  const done = pushStep(`Ranking elective options for "${description}" (Claude)`);
  try {
    const listText = options.map((o) => `${o.code}: ${o.title}`).join('\n');
    const task = interest
      ? `The student's stated interest(s): "${interest}".\n\n` +
        `Identify each DISTINCT interest mentioned (there may be more than one — e.g. "robotics and cybersecurity" is ` +
        `two) and produce a SEPARATE best-fit-to-worst-fit ranking of these options for EACH one individually. Rank ` +
        `each interest on its own merits — don't let how well one interest fits affect another interest's ranking.`
      : `The student didn't state a specific interest — rank these options from most broadly useful/well-rounded to least, ` +
        `favoring foundational or widely-applicable choices.`;

    const response = await getClient().messages.create({
      model: process.env.MODEL_NAME ?? 'claude-haiku-4-5',
      max_tokens: 1536,
      system: 'You help rank elective course choices for a student. Use the record_rankings tool to report your findings.',
      messages: [
        {
          role: 'user',
          content: `Elective choice: "${description}"\nOptions:\n${listText}\n\n${task}`,
        },
      ],
      tools: [RANK_TOOL],
      tool_choice: { type: 'tool', name: RANK_TOOL.name },
    });

    const toolUse = response.content.find((block) => block.type === 'tool_use');
    if (!toolUse || toolUse.type !== 'tool_use') return codes;

    const { rankingsByInterest } = toolUse.input as { rankingsByInterest: { interest: string; rankedCodes: string[] }[] };
    if (!rankingsByInterest || rankingsByInterest.length === 0) return codes;

    const validSet = new Set(codes);
    const cleanedRankings = rankingsByInterest.map(({ rankedCodes }) => {
      const ranked = rankedCodes.filter((c) => validSet.has(c));
      const missing = codes.filter((c) => !ranked.includes(c));
      return [...ranked, ...missing]; // any code the model dropped for this interest still gets included, just last
    });

    return interleaveRankings(cleanedRankings);
  } catch {
    return codes; // ranking is a nice-to-have; never let it block planning
  } finally {
    done();
  }
}
