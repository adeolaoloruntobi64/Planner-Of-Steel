import { test } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import { getProgramRequirementsSource } from './catalog';
import { parseProgramRequirements } from './requirements';

dotenv.config();

// The one LLM-backed test in this module (program requirement prose is too varied for a
// reliable regex, unlike course prereq text). Kept to a single real program to bound cost.
test('parseProgramRequirements extracts the known UTSC CS Major first-year courses', async () => {
  const source = await getProgramRequirementsSource('utsc', 'Computer-Science', 'SCMAJ1688');
  const result = await parseProgramRequirements(source);

  assert.equal(result.code, 'SCMAJ1688');
  for (const expected of ['CSCA08H3', 'CSCA48H3', 'CSCA67H3', 'MATA22H3', 'MATA31H3', 'MATA37H3']) {
    assert.ok(result.requiredCourses.includes(expected), `expected ${expected} in ${result.requiredCourses.join(', ')}`);
  }
});
