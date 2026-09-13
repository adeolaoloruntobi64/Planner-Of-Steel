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

// Regression test: the Statistics Minor's real elective slot is worded as "any C- or D-level
// STA course (excluding STAC32H3, STAC53H3, STAD29H3)" — not a literal list of codes. That used
// to get dropped outright as "doesn't look like a real UofT course code", silently turning a
// real, resolvable requirement into an empty group (and hiding genuine options like STAD68H3
// from a student who specifically wanted it). It should now resolve to real course codes.
test('parseProgramRequirements resolves a wildcard elective description into real course codes', async () => {
  const source = await getProgramRequirementsSource('utsc', 'Statistics', 'SCMIN2289');
  const result = await parseProgramRequirements(source);

  const wildcardGroup = result.electiveGroups.find((g) => /C- or D-level STA course/i.test(g.description));
  assert.ok(wildcardGroup, `expected a "C/D-level STA course" elective group, got: ${result.electiveGroups.map((g) => g.description).join(', ')}`);
  assert.ok(wildcardGroup!.options.length > 0, 'expected the wildcard description to resolve to real course codes, not an empty group');
  assert.ok(wildcardGroup!.options.includes('STAD68H3'), `expected STAD68H3 among resolved options, got: ${wildcardGroup!.options.join(', ')}`);
  for (const excluded of ['STAC32H3', 'STAC53H3', 'STAD29H3']) {
    assert.ok(!wildcardGroup!.options.includes(excluded), `expected ${excluded} to stay excluded, got: ${wildcardGroup!.options.join(', ')}`);
  }
});

// The same mechanism, but for a MULTI-department wildcard ("CSC, MAT, or STA elective") — a
// meaningfully different shape (bare subject list before "elective", not a single named subject
// with embedded exclusion codes) that needs each mentioned department's own course list, not
// just the one department the group happens to name first.
test('parseProgramRequirements resolves a multi-department wildcard elective across every named subject', async () => {
  const source = await getProgramRequirementsSource('utsc', 'Computer-Science', 'SCSPE0510');
  const result = await parseProgramRequirements(source);

  // Claude's exact phrasing/grouping of this elective varies run to run (a live, non-mocked
  // call) — match loosely by description, and fall back to "any group spanning 2+ departments"
  // so the test checks the actual behavior (multi-department resolution) rather than one exact
  // wording of it.
  const named = result.electiveGroups.find((g) => /CSC.*MAT.*STA|CSC, MAT, or STA/i.test(g.description));
  const multiDept = named ?? result.electiveGroups.find((g) => new Set(g.options.map((c) => c.slice(0, 3))).size > 1);
  assert.ok(multiDept, `expected some elective group spanning multiple departments, got: ${result.electiveGroups.map((g) => `${g.description} [${g.options.join(',')}]`).join(' | ')}`);
  const prefixes = new Set(multiDept!.options.map((c) => c.slice(0, 3)));
  assert.ok(prefixes.size > 1, `expected options from more than one department, got prefixes: ${[...prefixes].join(', ')} (options: ${multiDept!.options.join(', ')})`);
});
