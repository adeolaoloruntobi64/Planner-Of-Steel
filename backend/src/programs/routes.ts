import { Router } from 'express';
import type { Campus } from '../courses/calendar';
import { getProgramSections, getPrograms, getProgramRequirements } from './cache';
import { getCourseInfo } from '../courses/cache';

const router = Router();

function isCampus(value: string): value is Campus {
  return value === 'stgeorge' || value === 'utsc' || value === 'utm';
}

router.get('/:campus/sections', async (req, res) => {
  if (!isCampus(req.params.campus)) {
    res.status(400).json({ error: 'campus must be one of stgeorge, utsc, utm' });
    return;
  }
  try {
    res.json(await getProgramSections(req.params.campus));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.get('/:campus/sections/:slug', async (req, res) => {
  if (!isCampus(req.params.campus)) {
    res.status(400).json({ error: 'campus must be one of stgeorge, utsc, utm' });
    return;
  }
  try {
    res.json(await getPrograms(req.params.campus, req.params.slug));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.get('/:campus/sections/:slug/:code', async (req, res) => {
  if (!isCampus(req.params.campus)) {
    res.status(400).json({ error: 'campus must be one of stgeorge, utsc, utm' });
    return;
  }
  try {
    res.json(await getProgramRequirements(req.params.campus, req.params.slug, req.params.code));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Every course code referenced by this program (required + all elective options), with
// titles — lets the frontend populate a searchable "select your completed courses" dropdown
// scoped to a real, relevant list instead of needing a full campus-wide course catalog.
router.get('/:campus/sections/:slug/:code/courses', async (req, res) => {
  if (!isCampus(req.params.campus)) {
    res.status(400).json({ error: 'campus must be one of stgeorge, utsc, utm' });
    return;
  }
  try {
    const requirements = await getProgramRequirements(req.params.campus, req.params.slug, req.params.code);
    const codes = [...new Set([...requirements.requiredCourses, ...requirements.electiveGroups.flatMap((g) => g.options)])];
    const courses = await Promise.all(
      codes.map(async (code) => {
        try {
          const info = await getCourseInfo(code);
          return { code: info.code, title: info.title };
        } catch {
          return { code, title: code };
        }
      })
    );
    res.json(courses.sort((a, b) => a.code.localeCompare(b.code)));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
