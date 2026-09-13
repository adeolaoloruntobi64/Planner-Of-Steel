import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyProgramType, isValidCombo } from './combos';

test('classifyProgramType recognizes specialist/major/minor regardless of naming order', () => {
  assert.equal(classifyProgramType('MAJOR PROGRAM IN COMPUTER SCIENCE (SCIENCE)'), 'major');
  assert.equal(classifyProgramType('Computer Science - Specialist (Science) - ERSPE1688'), 'specialist');
  assert.equal(classifyProgramType('MINOR PROGRAM IN STATISTICS (SCIENCE)'), 'minor');
  assert.equal(classifyProgramType('SPECIALIST (CO-OPERATIVE) PROGRAM IN COMPUTER SCIENCE'), 'specialist');
  assert.equal(classifyProgramType('Something Unrelated'), null);
});

test('isValidCombo accepts only real UofT POSt combination shapes', () => {
  assert.equal(isValidCombo(['specialist']), true);
  assert.equal(isValidCombo(['specialist', 'specialist']), true);
  assert.equal(isValidCombo(['specialist', 'major']), true);
  assert.equal(isValidCombo(['specialist', 'minor']), true);
  assert.equal(isValidCombo(['major', 'major']), true);
  assert.equal(isValidCombo(['major', 'minor', 'minor']), true);
});

test('isValidCombo rejects unsupported shapes', () => {
  assert.equal(isValidCombo([]), false);
  assert.equal(isValidCombo(['major']), false); // a single major alone isn't a complete degree
  assert.equal(isValidCombo(['minor']), false);
  assert.equal(isValidCombo(['minor', 'minor']), false);
  assert.equal(isValidCombo(['specialist', 'major', 'minor']), false);
  assert.equal(isValidCombo(['major', 'major', 'major']), false);
  assert.equal(isValidCombo(['major', null]), false); // unrecognized program type
});
