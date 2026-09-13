import { test } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import { parseTranscript } from './transcript';

dotenv.config();

test('parseTranscript extracts completed courses and ignores in-progress ones', async () => {
  const result = await parseTranscript(
    `Program: B.S. Computer Science
Fall 2024
CS 1110 Intro to Computing - A
MATH 1910 Calculus I - B+
Spring 2025
CS 2110 Object-Oriented Programming - A
PHYS 1112 Physics I - IP`,
    'I want to graduate in 3 more semesters.'
  );

  assert.match(result.program, /computer science/i);
  assert.ok(result.completedCourses.includes('CS 1110'));
  assert.ok(result.completedCourses.includes('CS 2110'));
  assert.ok(!result.completedCourses.includes('PHYS 1112'));
});
