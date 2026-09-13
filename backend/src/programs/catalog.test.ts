import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listProgramSections, listPrograms, getProgramRequirementsSource } from './catalog';

test('listProgramSections finds Computer Science across all three campuses', async () => {
  for (const campus of ['stgeorge', 'utsc', 'utm'] as const) {
    const sections = await listProgramSections(campus);
    assert.ok(sections.length > 20, `expected many sections for ${campus}, got ${sections.length}`);
    assert.ok(sections.some((s) => s.slug === 'Computer-Science'), `expected a Computer-Science section for ${campus}`);
  }
});

test('listPrograms finds the UTSC Computer Science Major with its program code', async () => {
  const programs = await listPrograms('utsc', 'Computer-Science');
  const major = programs.find((p) => p.code === 'SCMAJ1688');
  assert.ok(major, `expected SCMAJ1688 among: ${programs.map((p) => p.code).join(', ')}`);
  assert.match(major!.name, /computer science/i);
});

test('getProgramRequirementsSource pulls real requirement text mentioning known first-year courses', async () => {
  const source = await getProgramRequirementsSource('utsc', 'Computer-Science', 'SCMAJ1688');
  assert.equal(source.code, 'SCMAJ1688');
  assert.match(source.requirementsHtml, /CSCA08H3/);
  assert.match(source.requirementsHtml, /CSCA48H3/);
});
