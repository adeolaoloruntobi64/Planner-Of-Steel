import * as cheerio from 'cheerio';
import type { Campus } from '../courses/calendar';

const CAMPUS_HOST: Record<Campus, string> = {
  stgeorge: 'artsci.calendar.utoronto.ca',
  utsc: 'utsc.calendar.utoronto.ca',
  utm: 'utm.calendar.utoronto.ca',
};

// Each campus's academic calendar site names its "index of all program subject areas"
// page differently, even though every page underneath is at the same /section/{slug} path.
const SECTION_INDEX_PATH: Record<Campus, string> = {
  stgeorge: '/listing-program-subject-areas',
  utsc: '/program-sections',
  utm: '/list-program-areas',
};

export interface ProgramSection {
  name: string;
  slug: string;
  url: string;
}

export interface ProgramSummary {
  code: string;
  name: string;
  campus: Campus;
  sectionSlug: string;
}

export interface ProgramRequirementsSource {
  code: string;
  name: string;
  campus: Campus;
  sectionSlug: string;
  requirementsHtml: string;
}

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`Failed to fetch ${url}: HTTP ${res.status}`);
  return res.text();
}

/** Lists every subject-area "section" a campus's calendar groups programs under (e.g. Computer Science). */
export async function listProgramSections(campus: Campus): Promise<ProgramSection[]> {
  const host = CAMPUS_HOST[campus];
  const html = await fetchHtml(`https://${host}${SECTION_INDEX_PATH[campus]}`);
  const $ = cheerio.load(html);

  const seen = new Map<string, ProgramSection>();
  $('a[href^="/section/"]').each((_, el) => {
    const href = $(el).attr('href');
    const name = $(el).text().trim();
    if (!href || !name) return;
    const slug = href.replace('/section/', '');
    if (!seen.has(slug)) {
      seen.set(slug, { name, slug, url: `https://${host}${href}` });
    }
  });

  return [...seen.values()];
}

const CODE_LABEL_RE = /^(.+?)\s*-\s*([A-Z]{2,6}[A-Z0-9]{3,8})$/;

/** Lists the individual programs (Major/Specialist/Minor/Focus/...) within one subject-area section. */
export async function listPrograms(campus: Campus, sectionSlug: string): Promise<ProgramSummary[]> {
  const host = CAMPUS_HOST[campus];
  const html = await fetchHtml(`https://${host}/section/${sectionSlug}`);
  const $ = cheerio.load(html);

  const seen = new Map<string, ProgramSummary>();
  $('h3.js-views-accordion-group-header [aria-label]').each((_, el) => {
    const label = $(el).attr('aria-label')?.trim();
    if (!label) return;
    const match = label.match(CODE_LABEL_RE);
    if (!match) return;
    const [, name, code] = match;
    if (!code || seen.has(code)) return;
    seen.set(code, { code, name: name!.trim(), campus, sectionSlug });
  });

  return [...seen.values()];
}

/**
 * Pulls the raw "Program Requirements" prose for one program — free-form text (streams,
 * electives, co-op options) that varies too much per program for a reliable regex, so it's
 * handed to an LLM (see programs/requirements.ts) rather than parsed here.
 */
export async function getProgramRequirementsSource(
  campus: Campus,
  sectionSlug: string,
  code: string
): Promise<ProgramRequirementsSource> {
  const host = CAMPUS_HOST[campus];
  const html = await fetchHtml(`https://${host}/section/${sectionSlug}`);
  const $ = cheerio.load(html);

  const header = $('h3.js-views-accordion-group-header').filter((_, el) => {
    const label = $(el).find('[aria-label]').first().attr('aria-label') ?? '';
    return label.match(CODE_LABEL_RE)?.[2] === code;
  }).first();

  if (header.length === 0) {
    throw new Error(`Program ${code} not found in section ${sectionSlug} (${campus})`);
  }

  const label = header.find('[aria-label]').first().attr('aria-label')!.trim();
  const name = label.match(CODE_LABEL_RE)![1]!.trim();

  // The program's fields (body, enrolment-requirements, completion-requirements) live nested
  // inside the same outer .views-row that wraps the accordion header itself.
  const programRow = header.closest('.views-row');
  const completion = programRow.find('.views-field-field-completion-requirements .field-content');
  const enrolment = programRow.find('.views-field-field-enrolment-requirements .field-content');
  const parts = [completion.length > 0 ? completion.text() : enrolment.text()];

  const requirementsHtml = parts.join('\n\n').replace(/\s+/g, ' ').trim();
  if (!requirementsHtml) {
    throw new Error(`No requirements text found for program ${code} in section ${sectionSlug} (${campus})`);
  }

  return { code, name, campus, sectionSlug, requirementsHtml };
}
