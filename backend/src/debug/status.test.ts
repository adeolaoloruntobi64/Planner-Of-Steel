import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pushStep, getStatus } from './status';

test('getStatus reports idle when nothing is in progress', () => {
  assert.deepEqual(getStatus(), { active: false, steps: [] });
});

test('pushStep reports as active until its callback is called, then reverts to idle', () => {
  const done = pushStep('Doing a thing');
  const status = getStatus();
  assert.equal(status.active, true);
  assert.equal(status.steps.length, 1);
  assert.equal(status.steps[0]?.label, 'Doing a thing');
  assert.ok(status.steps[0]!.runningForMs >= 0);

  done();
  assert.deepEqual(getStatus(), { active: false, steps: [] });
});

test('nested steps show as a breadcrumb trail, most recent first is not assumed order-sensitive', () => {
  const doneOuter = pushStep('Outer');
  const doneInner = pushStep('Inner');
  const labels = getStatus().steps.map((s) => s.label);
  assert.deepEqual(labels, ['Outer', 'Inner']);

  doneInner();
  assert.deepEqual(getStatus().steps.map((s) => s.label), ['Outer']);

  doneOuter();
  assert.equal(getStatus().active, false);
});
