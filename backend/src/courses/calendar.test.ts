import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchCourseInfo, campusForCode } from './calendar';

test('campusForCode maps the trailing digit to the right campus', () => {
  assert.equal(campusForCode('CSC148H1'), 'stgeorge');
  assert.equal(campusForCode('CSCA08H3'), 'utsc');
  assert.equal(campusForCode('CSC148H5'), 'utm');
  assert.throws(() => campusForCode('CSC148H9'));
});

test('fetchCourseInfo scrapes a St. George course', async () => {
  const info = await fetchCourseInfo('CSC148H1');
  assert.equal(info.code, 'CSC148H1');
  assert.equal(info.campus, 'stgeorge');
  assert.match(info.prerequisite ?? '', /CSC108H1/);
  assert.match(info.exclusion ?? '', /CSC148H5/);
  assert.ok(info.description && info.description.length > 20);
  // The calendar page's own <h1> reads "CSC148H1: Introduction to Computer Science" — every
  // caller already has the code separately, so the stored title shouldn't repeat it (that's
  // what produced "CSC148H1: CSC148H1: Introduction to Computer Science" wherever code and
  // title get displayed together).
  assert.ok(!info.title.startsWith('CSC148H1'), `expected the course code prefix to be stripped from the title, got: "${info.title}"`);
});

test('fetchCourseInfo scrapes a UTSC course', async () => {
  const info = await fetchCourseInfo('CSCA08H3');
  assert.equal(info.campus, 'utsc');
  assert.ok(info.breadthRequirement);
});

test('fetchCourseInfo scrapes a UTM course', async () => {
  const info = await fetchCourseInfo('CSC148H5');
  assert.equal(info.campus, 'utm');
  assert.match(info.prerequisite ?? '', /CSC108H5/);
});

test('fetchCourseInfo captures corequisite and recommended preparation when present', async () => {
  const info = await fetchCourseInfo('PHY131H1');
  assert.match(info.corequisite ?? '', /MAT137Y1/);
  assert.ok(info.recommendedPreparation);
});
