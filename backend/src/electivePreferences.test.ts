import { test } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import { rankElectiveOptions } from './electivePreferences';

dotenv.config();

test('rankElectiveOptions prioritizes the option matching a stated interest', async () => {
  const options = [
    { code: 'CSCC10H3', title: 'Human-Computer Interaction' },
    { code: 'CSCD27H3', title: 'Computer and Network Security' },
    { code: 'CSCC11H3', title: 'Introduction to Machine Learning and Data Mining' },
  ];

  const ranked = await rankElectiveOptions('CS elective', options, 'cybersecurity');
  assert.equal(ranked.length, 3);
  assert.deepEqual([...ranked].sort(), [...options.map((o) => o.code)].sort()); // same set, just reordered
  assert.equal(ranked[0], 'CSCD27H3', `expected the security course to rank first for a cybersecurity interest, got: ${ranked.join(', ')}`);
});

test('rankElectiveOptions represents every stated interest near the top, not just one', async () => {
  const options = [
    { code: 'CSCC85H3', title: 'Fundamentals of Robotics and Automated Systems' },
    { code: 'CSCD27H3', title: 'Computer and Network Security' },
    { code: 'CSCC10H3', title: 'Human-Computer Interaction' },
    { code: 'ENGB06H3', title: 'Canadian Literature to 1900' },
  ];

  const ranked = await rankElectiveOptions('CS elective', options, "I'm interested in robotics and cybersecurity");
  assert.equal(ranked.length, 4);
  assert.deepEqual([...ranked].sort(), [...options.map((o) => o.code)].sort());

  const top2 = ranked.slice(0, 2);
  assert.ok(top2.includes('CSCC85H3'), `expected the robotics course in the top 2, got: ${ranked.join(', ')}`);
  assert.ok(top2.includes('CSCD27H3'), `expected the security course in the top 2, got: ${ranked.join(', ')}`);
});

test('rankElectiveOptions returns options unchanged when there is nothing to choose between', async () => {
  assert.deepEqual(await rankElectiveOptions('Only one option', [{ code: 'CSCA08H3', title: 'x' }], undefined), ['CSCA08H3']);
  assert.deepEqual(await rankElectiveOptions('No options', [], 'cybersecurity'), []);
});
