import * as cheerio from 'cheerio';

export type Campus = 'stgeorge' | 'utsc' | 'utm';

export interface CourseInfo {
  code: string;
  campus: Campus;
  title: string;
  description?: string;
  prerequisite?: string;
  corequisite?: string;
  exclusion?: string;
  recommendedPreparation?: string;
  breadthRequirement?: string;
  url: string;
}

const CAMPUS_HOST: Record<Campus, string> = {
  stgeorge: 'artsci.calendar.utoronto.ca',
  utsc: 'utsc.calendar.utoronto.ca',
  utm: 'utm.calendar.utoronto.ca',
};

const CAMPUS_BY_SUFFIX: Record<string, Campus> = {
  '1': 'stgeorge',
  '3': 'utsc',
  '5': 'utm',
};

export function campusForCode(code: string): Campus {
  const suffix = code.trim().slice(-1);
  const campus = CAMPUS_BY_SUFFIX[suffix];
  if (!campus) {
    throw new Error(`Cannot determine campus for course code "${code}" (expected suffix H1/Y1, H3/Y3, or H5/Y5)`);
  }
  return campus;
}

function textOf(el: ReturnType<cheerio.CheerioAPI>): string | undefined {
  if (el.length === 0) return undefined;
  const clone = el.clone();
  clone.find('.field__label').remove();
  const text = clone.text().replace(/\s+/g, ' ').trim();
  return text || undefined;
}

function fieldText($: cheerio.CheerioAPI, scope: ReturnType<cheerio.CheerioAPI>, name: string): string | undefined {
  return textOf(scope.find(`[class*="field--name-field-${name}"]`).first());
}

export async function fetchCourseInfo(code: string): Promise<CourseInfo> {
  const campus = campusForCode(code);
  const url = `https://${CAMPUS_HOST[campus]}/course/${code.toLowerCase()}`;

  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) {
    throw new Error(`Failed to fetch course ${code}: HTTP ${res.status}`);
  }
  const html = await res.text();
  const $ = cheerio.load(html);

  const article = $('article.node--type-courses').first();
  if (article.length === 0) {
    throw new Error(`No course found for ${code} at ${url}`);
  }
  const title = $('h1.page-title').first().text().replace(/\s+/g, ' ').trim() || code;
  const description = fieldText($, article, 'desc') ?? textOf(article.find('.field--name-body').first());
  const prerequisite = fieldText($, article, 'prerequisite');
  const corequisite = fieldText($, article, 'corequisite');
  const exclusion = fieldText($, article, 'exclusion');
  const recommendedPreparation = fieldText($, article, 'recommended');
  const breadthRequirement = fieldText($, article, 'breadth-requirements') ?? fieldText($, article, 'distribution-requirements');

  return {
    code: code.toUpperCase(),
    campus,
    title,
    ...(description && { description }),
    ...(prerequisite && { prerequisite }),
    ...(corequisite && { corequisite }),
    ...(exclusion && { exclusion }),
    ...(recommendedPreparation && { recommendedPreparation }),
    ...(breadthRequirement && { breadthRequirement }),
    url,
  };
}
