import Anthropic from '@anthropic-ai/sdk';
import { pushStep } from './debug/status';

let anthropic: Anthropic | undefined;
function getClient(): Anthropic {
  anthropic ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return anthropic;
}

export interface ParsedTranscript {
  /** Finished, graded courses. */
  completedCourses: string[];
  /** Currently-enrolled courses (not yet graded) — assumed to complete, but tracked separately for display. */
  inProgressCourses: string[];
  /** How many academic terms (Fall/Winter/Summer) are already finished or in progress. */
  semestersElapsed: number;
  /** The session the NEW plan should start from (the term right after the most recent one on the transcript). */
  nextSession: 'F' | 'S';
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
        description: 'Course codes the student has FINISHED and been graded for (not currently in progress, not failed).',
      },
      inProgressCourses: {
        type: 'array',
        items: { type: 'string' },
        description: 'Course codes the student is CURRENTLY taking (status like "IPR"/"In Progress"), not yet graded.',
      },
      semestersElapsed: {
        type: 'number',
        description:
          'Count of distinct academic terms (each Fall, Winter, or Summer session) that are already finished or currently ' +
          'in progress, based on the SESSION headers in the transcript. A combined "Fall/Winter" in-progress block counts ' +
          'as 2 terms. Used to number the new plan\'s semesters starting from the student\'s true position (e.g. a student ' +
          'starting their 6th term gets semesters numbered 6, 7, 8... not 1, 2, 3...).',
      },
      nextSession: {
        type: 'string',
        enum: ['F', 'S'],
        description:
          '"F" (Fall) or "S" (Winter) — the session immediately after the most recent one on the transcript, i.e. the ' +
          'session the new plan\'s first semester should be. If the student is currently in a Fall/Winter in-progress ' +
          'block, this is the Fall following it.',
      },
      program: {
        type: 'string',
        description: "The student's declared major/program, e.g. \"Computer Science\".",
      },
      notes: {
        type: 'string',
        description: 'Anything relevant from the freeform prompt: target graduation term, planned breaks, preferences, minors, career interests, etc.',
      },
    },
    required: ['completedCourses', 'inProgressCourses', 'semestersElapsed', 'nextSession', 'program'],
  },
};

const SYSTEM_PROMPT =
  'You extract structured data from unofficial college transcripts, including where the student currently stands ' +
  'in their academic timeline. Use the record_transcript_data tool to report your findings.';

async function extractFromContent(content: Anthropic.MessageParam['content']): Promise<ParsedTranscript> {
  const response = await getClient().messages.create({
    model: process.env.MODEL_NAME ?? 'claude-haiku-4-5',
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content }],
    tools: [EXTRACT_TOOL],
    tool_choice: { type: 'tool', name: EXTRACT_TOOL.name },
  });

  const toolUse = response.content.find((block) => block.type === 'tool_use');
  if (!toolUse || toolUse.type !== 'tool_use') {
    throw new Error('Model did not return structured transcript data');
  }

  return toolUse.input as ParsedTranscript;
}

export async function parseTranscript(transcriptText: string, prompt?: string): Promise<ParsedTranscript> {
  const done = pushStep('Parsing transcript (Claude)');
  try {
    const text = [`Transcript:\n${transcriptText}`, prompt ? `Additional context from the student:\n${prompt}` : '']
      .filter(Boolean)
      .join('\n\n');
    return await extractFromContent(text);
  } finally {
    done();
  }
}

export type TranscriptFileKind = 'pdf' | 'image';

/**
 * Same extraction as parseTranscript, but for an uploaded PDF or image of a transcript.
 * Claude reads PDF/image documents natively as a message content block, so this skips a
 * separate OCR step entirely — just a different content block type feeding the same tool-use
 * extraction pattern.
 */
export async function parseTranscriptFromFile(
  fileBuffer: Buffer,
  mimeType: string,
  kind: TranscriptFileKind,
  prompt?: string
): Promise<ParsedTranscript> {
  const done = pushStep('Parsing transcript file (Claude)');
  try {
    const data = fileBuffer.toString('base64');
    const fileBlock: Anthropic.ContentBlockParam =
      kind === 'pdf'
        ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
        : { type: 'image', source: { type: 'base64', media_type: mimeType as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif', data } };

    const content: Anthropic.ContentBlockParam[] = [
      fileBlock,
      { type: 'text', text: prompt ? `Additional context from the student:\n${prompt}` : 'This is the student\'s unofficial transcript.' },
    ];

    return await extractFromContent(content);
  } finally {
    done();
  }
}
