import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toMinutes, slotsConflict, slotsFor, chooseSections, type CourseSectionGroup } from './sections';
import type { CourseSection } from './ttb';

test('toMinutes parses 12-hour clock times', () => {
  assert.equal(toMinutes('9:00 AM'), 9 * 60);
  assert.equal(toMinutes('12:00 PM'), 12 * 60);
  assert.equal(toMinutes('12:00 AM'), 0);
  assert.equal(toMinutes('1:30 PM'), 13 * 60 + 30);
});

test('slotsConflict detects overlapping meetings on the same day only', () => {
  const a = slotsFor([{ day: 'Monday', start: '10:00 AM', end: '11:00 AM' }]);
  const overlapping = slotsFor([{ day: 'Monday', start: '10:30 AM', end: '11:30 AM' }]);
  const sameDayNoOverlap = slotsFor([{ day: 'Monday', start: '11:00 AM', end: '12:00 PM' }]);
  const differentDay = slotsFor([{ day: 'Tuesday', start: '10:00 AM', end: '11:00 AM' }]);

  assert.equal(slotsConflict(a, overlapping), true);
  assert.equal(slotsConflict(a, sameDayNoOverlap), false); // back-to-back, not overlapping
  assert.equal(slotsConflict(a, differentDay), false);
});

function section(code: string, type: string, day: string, start: string, end: string): CourseSection {
  return { code, type, meetings: [{ day, start, end }] };
}

test('chooseSections avoids conflicts by default when a non-conflicting option exists', () => {
  const courses: CourseSectionGroup[] = [
    { code: 'CSCA08H3', sections: [section('LEC01', 'LEC', 'Monday', '10:00 AM', '11:00 AM')] },
    {
      code: 'MATA30H3',
      sections: [
        section('LEC01', 'LEC', 'Monday', '10:30 AM', '11:30 AM'), // conflicts
        section('LEC02', 'LEC', 'Tuesday', '10:00 AM', '11:00 AM'), // free
      ],
    },
  ];

  const result = chooseSections(courses);
  assert.equal(result.hasUnresolvedConflicts, false);
  const mat = result.chosen.find((c) => c.courseCode === 'MATA30H3');
  assert.equal(mat?.section.code, 'LEC02');
});

test('chooseSections reports conflicts instead of avoiding them when none can be avoided', () => {
  const courses: CourseSectionGroup[] = [
    { code: 'CSCA08H3', sections: [section('LEC01', 'LEC', 'Monday', '10:00 AM', '11:00 AM')] },
    { code: 'MATA30H3', sections: [section('LEC01', 'LEC', 'Monday', '10:30 AM', '11:30 AM')] },
  ];

  const result = chooseSections(courses);
  assert.equal(result.hasUnresolvedConflicts, true);
  const mat = result.chosen.find((c) => c.courseCode === 'MATA30H3');
  assert.equal(mat?.conflictsWith.length, 1);
  assert.equal(mat?.conflictsWith[0]?.courseCode, 'CSCA08H3');
});

test('chooseSections with a morning preference picks the earliest non-conflicting option', () => {
  const courses: CourseSectionGroup[] = [
    {
      code: 'CSCA08H3',
      sections: [
        section('LEC01', 'LEC', 'Monday', '9:00 AM', '10:00 AM'),
        section('LEC02', 'LEC', 'Monday', '2:00 PM', '3:00 PM'),
      ],
    },
  ];

  const result = chooseSections(courses, { timePreference: 'morning' });
  assert.equal(result.chosen[0]?.section.code, 'LEC01');

  const eveningResult = chooseSections(courses, { timePreference: 'evening' });
  assert.equal(eveningResult.chosen[0]?.section.code, 'LEC02');
});
