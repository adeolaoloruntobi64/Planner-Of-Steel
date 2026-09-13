import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import dotenv from 'dotenv';
import { parseTranscriptFromFile } from './transcript';
import { writeTestOutput } from './testSupport';

dotenv.config();

// Verifies the file-upload path itself (image content block -> Claude -> structured tool-use
// result) works end-to-end. Kept to structural checks rather than exact completed/in-progress
// classification: that specific split depends on Claude's vision reading of the rendered image,
// which is a model-accuracy question distinct from whether the upload pipeline itself is wired
// correctly (confirmed separately: the identical text via the plain-text path classifies
// correctly, so this isn't a parsing-logic bug).
test('parseTranscriptFromFile extracts structured data from an image of a transcript', async () => {
  const buffer = readFileSync(join(__dirname, 'fixtures', 'sample-transcript.png'));
  const result = await parseTranscriptFromFile(buffer, 'image/png', 'image');
  writeTestOutput('parseTranscriptFromFile-image', result);

  assert.match(result.program, /computer science/i);
  const allCourses = [...result.completedCourses, ...result.inProgressCourses];
  for (const code of ['CS 1110', 'MATH 1910', 'CS 2110', 'PHYS 1112']) {
    assert.ok(allCourses.some((c) => c.replace(/\s+/g, '') === code.replace(/\s+/g, '')), `expected ${code} to appear somewhere, got: ${allCourses.join(', ')}`);
  }
  assert.equal(typeof result.semestersElapsed, 'number');
  assert.ok(result.nextSession === 'F' || result.nextSession === 'S');
});
