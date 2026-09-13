import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retrieveTree, extractCodes, parsePrereqGroups, clearTreeMemo } from './retrieveTree';

test('extractCodes pulls UofT course codes out of freeform text', () => {
  assert.deepEqual(extractCodes('CSC108H1/ (equivalent programming experience)'), ['CSC108H1']);
  assert.deepEqual(
    extractCodes('CSC111H1, CSC207H1, CSC148H5, CSC207H5, CSCA48H3, CSCB07H3'),
    ['CSC111H1', 'CSC207H1', 'CSC148H5', 'CSC207H5', 'CSCA48H3', 'CSCB07H3']
  );
  assert.deepEqual(extractCodes('Grade 12 Calculus and Vectors'), []);
});

test('parsePrereqGroups splits AND-joined requirements into separate groups, preserving OR within a clause', () => {
  // Real UofT text (CSCC69H3): three distinct AND-requirements, the last a non-course condition.
  assert.deepEqual(
    parsePrereqGroups('CSCB07H3 and CSCB09H3 and CSCB58H3 and [CGPA 3.5 or enrolment in a CSC Subject POSt]'),
    [['CSCB07H3'], ['CSCB09H3'], ['CSCB58H3']] // the GPA/POSt clause has no course code, so it drops out
  );
  // Real UofT text (PHY131H1 corequisite): one clause, several OR-alternatives.
  assert.deepEqual(parsePrereqGroups('MAT130H1/ MAT135H1/ MAT137Y1'), [['MAT130H1', 'MAT135H1', 'MAT137Y1']]);
  assert.deepEqual(parsePrereqGroups(undefined), []);
});

test('parsePrereqGroups does not split "and" inside a nested bracket', () => {
  // Real UofT text (MATB41H3): a naive split on every "and" breaks inside the nested
  // "[MAT137H5 and MAT139H5]" OR-alternative, creating a spurious 4th AND-group that
  // incorrectly requires the UTM-only MAT159H5 unconditionally. Top-level structure is just
  // two AND-groups; this asserts the fix does not further split the second one.
  const groups = parsePrereqGroups(
    '[MATA22H3 or MATA23H3 or MAT223H] and [[MATA36H3 or MATA37H3] or [MAT137H5 and MAT139H5] or [MAT157H5 and MAT159H5]]'
  );
  assert.equal(groups.length, 2, `expected exactly 2 top-level AND-groups, got ${JSON.stringify(groups)}`);
  assert.deepEqual(groups[0], ['MATA22H3', 'MATA23H3']);
  assert.deepEqual(groups[1], ['MATA36H3', 'MATA37H3', 'MAT137H5', 'MAT139H5', 'MAT157H5', 'MAT159H5']);
});

test('retrieveTree expands CSC148H1 down to its prerequisite CSC108H1', async () => {
  clearTreeMemo();
  const tree = await retrieveTree('CSC148H1');
  assert.equal(tree.code, 'CSC148H1');
  assert.ok(tree.prereqGroups.some((group) => group.includes('CSC108H1')));
  const child = tree.children.find((c) => c.code === 'CSC108H1');
  assert.ok(child, 'expected CSC108H1 to be expanded as a child node');
});

test('retrieveTree preserves an AND relationship for a course with multiple real prerequisites', async () => {
  // CSCC69H3 genuinely requires CSCB07H3 AND CSCB09H3 AND CSCB58H3 — not "any one of them".
  clearTreeMemo();
  const tree = await retrieveTree('CSCC69H3', 1);
  assert.ok(tree.prereqGroups.length >= 3, `expected at least 3 AND-groups, got ${JSON.stringify(tree.prereqGroups)}`);
  for (const code of ['CSCB07H3', 'CSCB09H3', 'CSCB58H3']) {
    assert.ok(
      tree.prereqGroups.some((group) => group.length === 1 && group[0] === code),
      `expected ${code} to be its own required AND-group, got ${JSON.stringify(tree.prereqGroups)}`
    );
  }
});

test('retrieveTree resolves MATB41H3 as satisfiable via MATA37H3 alone, not blocked by a nested nested clause', async () => {
  clearTreeMemo();
  const tree = await retrieveTree('MATB41H3', 1);
  assert.equal(tree.prereqGroups.length, 2, `expected 2 AND-groups, got ${JSON.stringify(tree.prereqGroups)}`);
  assert.ok(tree.prereqGroups.some((g) => g.includes('MATA37H3')), `expected an OR-group containing MATA37H3, got ${JSON.stringify(tree.prereqGroups)}`);
});

test('retrieveTree extracts a credit-count threshold from a prerequisite with no course code', async () => {
  // Real UofT text (CSCD03H3): "14.0 credits and enrolment in a Computer Science Subject POSt.
  // Restricted to..." — no course code at all, so parsePrereqGroups correctly produces zero
  // groups. Without tracking the credit threshold separately, an empty AND-of-OR check is
  // vacuously true, making a 4th-year-only course look completely prereq-free.
  clearTreeMemo();
  const tree = await retrieveTree('CSCD03H3', 1);
  assert.deepEqual(tree.prereqGroups, [], 'expected no course-code prereq groups');
  assert.equal(tree.minCreditsRequired, 14, `expected a 14-credit threshold, got ${tree.minCreditsRequired}`);
});

test('retrieveTree applies a level-letter credit floor and flags consent-gated independent study courses', async () => {
  // Real UofT text (STAD95H3, "Statistics Project"): "Students must obtain consent from the
  // Supervisor of Studies before registering for this course." — no course code AND no numeric
  // credit threshold at all, so neither prereqGroups nor the earlier credit-threshold parse
  // catch it. The course's own level letter ("D") is the only signal left that this shouldn't
  // be scheduled early, and the consent requirement means it shouldn't be auto-picked at all.
  clearTreeMemo();
  const tree = await retrieveTree('STAD95H3', 1);
  assert.deepEqual(tree.prereqGroups, []);
  assert.ok(tree.minCreditsRequired !== undefined && tree.minCreditsRequired >= 14, `expected a D-level credit floor, got ${tree.minCreditsRequired}`);
  assert.equal(tree.requiresPermission, true, 'expected a consent-gated course to be flagged');
});

test('retrieveTree does not apply the year-level credit floor to co-op administrative course codes', async () => {
  // COPB50H3 ("Foundations for Success in Arts and Science Co-op") is a genuine first-year
  // co-op prep course, but its code's 4th character ("B") coincidentally looks like a 2nd-year
  // level letter under the normal A-D convention — co-op codes don't follow that convention at
  // all, so applying the floor here would wrongly delay a real first-year requirement.
  clearTreeMemo();
  const tree = await retrieveTree('COPB50H3', 1);
  assert.ok(!tree.minCreditsRequired, `expected no credit floor on a co-op prep course, got ${tree.minCreditsRequired}`);
});

test('retrieveTree truncates instead of looping when maxDepth is hit', async () => {
  clearTreeMemo();
  const tree = await retrieveTree('CSC148H1', 1);
  assert.equal(tree.children.length, 0);
  assert.ok(tree.truncated.includes('CSC108H1'));
});
