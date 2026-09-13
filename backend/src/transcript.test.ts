import { test } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import { parseTranscript } from './transcript';
import { writeTestOutput } from './testSupport';

dotenv.config();

test('parseTranscript separates finished courses from in-progress ones', async () => {
  const result = await parseTranscript(
    `Program: B.S. Computer Science
Fall 2024
CS 1110 Intro to Computing - A
MATH 1910 Calculus I - B+
Spring 2025
CS 2110 Object-Oriented Programming - A
PHYS 1112 Physics I - Status: In Progress (IPR)`,
    'I want to graduate in 3 more semesters.'
  );
  writeTestOutput('parseTranscript-basic', result);

  assert.match(result.program, /computer science/i);
  assert.ok(result.completedCourses.includes('CS 1110'));
  assert.ok(result.completedCourses.includes('CS 2110'));
  assert.ok(!result.completedCourses.includes('PHYS 1112'), 'in-progress course should not be listed as completed');
  assert.ok(result.inProgressCourses.includes('PHYS 1112'), `expected PHYS 1112 in inProgressCourses, got: ${result.inProgressCourses.join(', ')}`);
  assert.equal(typeof result.semestersElapsed, 'number');
  assert.ok(result.semestersElapsed >= 2, `expected at least 2 elapsed terms (Fall 2024, Spring 2025), got ${result.semestersElapsed}`);
  assert.ok(result.nextSession === 'F' || result.nextSession === 'S');
});
