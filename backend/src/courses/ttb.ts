import { campusForCode, type Campus } from './calendar';
import { pushStep } from '../debug/status';
import { withPooledPage } from './steelPool';

export interface SectionMeeting {
  day: string;
  start: string;
  end: string;
}

export interface CourseSection {
  code: string;
  type: string;
  meetings: SectionMeeting[];
  instructor?: string;
}

export type Session = 'F' | 'S' | 'Y';

export interface TermOffering {
  session: Session;
  sections: CourseSection[];
}

export interface CourseOfferings {
  code: string;
  campus: Campus;
  offerings: TermOffering[];
}

const DIVISION_LABEL: Record<Campus, string> = {
  stgeorge: 'Faculty of Arts and Science',
  utsc: 'University of Toronto Scarborough',
  utm: 'University of Toronto Mississauga',
};

function parseMeeting(text: string): SectionMeeting {
  const match = text.match(/^(\S+)\s+(.+?)\s*-\s*(.+)$/);
  if (!match) return { day: text, start: '', end: '' };
  const [, day, start, end] = match;
  return { day: day ?? '', start: start ?? '', end: end ?? '' };
}

interface RawSection {
  code: string;
  meetings: string[];
  instructor?: string | undefined;
}

const offeringsCache = new Map<string, Promise<CourseOfferings>>();

/**
 * Cache-aside wrapper around fetchCourseOfferings, keyed by course code. Offerings for the
 * current term don't change within a process's runtime, and callers legitimately need the
 * same course's data more than once (e.g. an upfront "is this course still offered at all"
 * validation pass followed by the real per-semester scheduling check) — without this, that
 * would mean two live Steel lookups for the same course instead of one.
 */
export function getCourseOfferings(code: string): Promise<CourseOfferings> {
  const upper = code.toUpperCase();
  const cached = offeringsCache.get(upper);
  if (cached) return cached;

  const promise = fetchCourseOfferings(upper).catch((err) => {
    offeringsCache.delete(upper); // don't cache a failure — let the next caller retry
    throw err;
  });
  offeringsCache.set(upper, promise);
  return promise;
}

/**
 * Drives the live UofT Timetable Builder (ttb.utoronto.ca) for a single course: which
 * session(s) (F/S/Y) it's offered in, and for each, its LEC/TUT/PRA sections and meeting
 * times. This app is a client-rendered Angular SPA with no public API, so a real browser
 * (via Steel) is the only way to get this data.
 */
async function fetchCourseOfferings(code: string): Promise<CourseOfferings> {
  const upper = code.toUpperCase();
  const campus = campusForCode(upper);
  const division = DIVISION_LABEL[campus];

  const done = pushStep(`Checking ttb.utoronto.ca offerings for ${upper} (Steel)`);
  try {
    return await withPooledPage(async (page, state) => {
    // Reusing a tab that's already on ttb.utoronto.ca with the right division selected skips
    // the full page load + Angular bootstrap + dropdown re-selection entirely — just clear the
    // search field and type the next code. That's the dominant cost per lookup, so this makes
    // repeat calls on a warm tab much faster than treating every lookup as a cold start.
    const ttbState = state as { initialized?: boolean; divisions?: Set<Campus> };
    if (!ttbState.initialized) {
      await page.goto('https://ttb.utoronto.ca/', { waitUntil: 'networkidle', timeout: 30000 });
      ttbState.initialized = true;
      ttbState.divisions = new Set();
    }
    if (!ttbState.divisions!.has(campus)) {
      await page.click('#division-combo-top-container');
      await page.getByText(division, { exact: true }).click();
      await page.keyboard.press('Escape');
      ttbState.divisions!.add(campus);
    }

    const courseInput = page.locator('input[placeholder="Type something"]').first();
    await courseInput.click();
    await courseInput.fill(upper);
    await page.getByText(`${upper}- Search keyword(s)`, { exact: true }).click();

    await page.click('button:has-text("Search")');
    // Wait for THIS course's specific result, not just any ".accordion-item" — on a reused
    // tab, stale results from the previous search are still in the DOM the instant Search is
    // clicked, so a generic wait resolves immediately and the code races ahead of Angular
    // actually re-rendering the new results (reliably reproduced: search course A, then B on
    // the same tab, and B would come back with zero offerings even though it has real ones).
    const headerButtons = page.locator('.accordion-button', { hasText: new RegExp(`^${upper} [FSY]:`) });
    await headerButtons.first().waitFor({ timeout: 15000 }).catch(() => {}); // genuinely zero results is a valid outcome too
    const count = await headerButtons.count();

    const offerings: TermOffering[] = [];
    for (let i = 0; i < count; i++) {
      const button = headerButtons.nth(i);
      const label = (await button.innerText()).trim();
      const sessionMatch = label.match(/\s([FSY]):/);
      const session = (sessionMatch?.[1] ?? 'F') as Session;

      const targetId = await button.getAttribute('aria-controls');
      await button.click();
      if (targetId) {
        await page.waitForSelector(`#${targetId} .course-section`, { timeout: 10000 }).catch(() => {});
      }

      const rawSections: RawSection[] = targetId
        ? await page.evaluate((id) => {
            const container = document.getElementById(id);
            if (!container) return [];
            return Array.from(container.querySelectorAll('.course-section')).map((sectionEl) => {
              const sectionCode = sectionEl.querySelector('h5.header span')?.textContent?.trim() ?? '';
              const items = Array.from(sectionEl.querySelectorAll('.section-item'));
              const dayTimeItem = items.find((it) => it.querySelector('.day-time'));
              const meetings = dayTimeItem
                ? Array.from(dayTimeItem.querySelectorAll('.item-value > div > span')).map(
                    (s) => s.textContent?.trim() ?? ''
                  )
                : [];
              const instructorItem = items.find((it) => it.querySelector('.instructor'));
              const instructor = instructorItem?.querySelector('.item-value')?.textContent?.trim();
              return { code: sectionCode, meetings, instructor };
            });
          }, targetId)
        : [];

      offerings.push({
        session,
        sections: rawSections
          .filter((s) => s.code)
          .map((s) => ({
            code: s.code,
            type: s.code.match(/^[A-Z]+/)?.[0] ?? 'LEC',
            meetings: s.meetings.filter(Boolean).map(parseMeeting),
            ...(s.instructor && { instructor: s.instructor }),
          })),
      });

      await button.click(); // collapse before moving on
    }

    return { code: upper, campus, offerings };
    });
  } finally {
    done();
  }
}
