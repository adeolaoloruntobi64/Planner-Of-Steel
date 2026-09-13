import Anthropic from '@anthropic-ai/sdk';
import { pushStep } from './debug/status';

let anthropic: Anthropic | undefined;
function getClient(): Anthropic {
  anthropic ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return anthropic;
}

export interface ParsedTranscript {
  completedCourses: string[];
  program: string;
  notes?: string;
}

const EXTRACT_TOOL = {
  name: 'record_transcript_data',
  description: 'Record structured data extracted from an unofficial transcript.',
  input_schema: {
    type: 'object' as const,
    properties: {
      completedCourses: {
        type: 'array',
        items: { type: 'string' },
        description: 'Course codes the student has already completed or passed (e.g. "CS 2110").',
      },
      program: {
        type: 'string',
        description: "The student's declared major/program, e.g. \"Computer Science\".",
      },
      notes: {
        type: 'string',
        description: 'Anything relevant from the freeform prompt: target graduation term, planned breaks, preferences, minors, etc.',
      },
    },
    required: ['completedCourses', 'program'],
  },
};

export async function parseTranscript(transcriptText: string, prompt?: string): Promise<ParsedTranscript> {
  const done = pushStep('Parsing transcript (Claude)');
  try {
  const response = await getClient().messages.create({
    model: process.env.MODEL_NAME ?? 'claude-haiku-4-5',
    max_tokens: 2048,
    system:
      'You extract structured data from unofficial college transcripts. ' +
      'Identify completed/passed courses (ignore in-progress or failed ones unless the transcript says otherwise) ' +
      'and the student\'s declared program. Use the record_transcript_data tool to report your findings.',
    messages: [
      {
        role: 'user',
        content: [
          `Transcript:\n${transcriptText}`,
          prompt ? `Additional context from the student:\n${prompt}` : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
      },
    ],
    tools: [EXTRACT_TOOL],
    tool_choice: { type: 'tool', name: EXTRACT_TOOL.name },
  });

  const toolUse = response.content.find((block) => block.type === 'tool_use');
  if (!toolUse || toolUse.type !== 'tool_use') {
    throw new Error('Model did not return structured transcript data');
  }

  return toolUse.input as ParsedTranscript;
  } finally {
    done();
  }
}
