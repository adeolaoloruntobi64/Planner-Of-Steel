import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retrieveTree, extractCodes, clearTreeMemo } from './retrieveTree';

test('extractCodes pulls UofT course codes out of freeform text', () => {
  assert.deepEqual(extractCodes('CSC108H1/ (equivalent programming experience)'), ['CSC108H1']);
  assert.deepEqual(
    extractCodes('CSC111H1, CSC207H1, CSC148H5, CSC207H5, CSCA48H3, CSCB07H3'),
    ['CSC111H1', 'CSC207H1', 'CSC148H5', 'CSC207H5', 'CSCA48H3', 'CSCB07H3']
  );
  assert.deepEqual(extractCodes('Grade 12 Calculus and Vectors'), []);
});

test('retrieveTree expands CSC148H1 down to its prerequisite CSC108H1', async () => {
  clearTreeMemo();
  const tree = await retrieveTree('CSC148H1');
  assert.equal(tree.code, 'CSC148H1');
  assert.ok(tree.prereqCourses.includes('CSC108H1'));
  const child = tree.children.find((c) => c.code === 'CSC108H1');
  assert.ok(child, 'expected CSC108H1 to be expanded as a child node');
});

test('retrieveTree truncates instead of looping when maxDepth is hit', async () => {
  clearTreeMemo();
  const tree = await retrieveTree('CSC148H1', 1);
  assert.equal(tree.children.length, 0);
  assert.ok(tree.truncated.includes('CSC108H1'));
});
