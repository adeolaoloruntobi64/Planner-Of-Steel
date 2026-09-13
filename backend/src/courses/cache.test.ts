import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getCourseInfo, warmCache, cacheStatus } from './cache';

test('getCourseInfo caches results (cache-aside)', async () => {
  const before = cacheStatus().size;
  const first = await getCourseInfo('CSC108H1');
  const afterFirst = cacheStatus();
  assert.equal(afterFirst.size, before + 1);
  assert.ok(afterFirst.codes.includes('CSC108H1'));

  const second = await getCourseInfo('csc108h1'); // lowercase, should hit cache
  assert.equal(cacheStatus().size, afterFirst.size); // no growth: cache hit
  assert.deepEqual(second, first);
});

test('warmCache fetches multiple codes concurrently and reports failures separately', async () => {
  const result = await warmCache(['CSC148H1', 'NOTACOURSEH1']);
  assert.ok(result.warmed.includes('CSC148H1'));
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0]?.code, 'NOTACOURSEH1');
});
