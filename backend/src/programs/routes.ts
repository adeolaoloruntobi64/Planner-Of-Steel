import { Router } from 'express';
import type { Campus } from '../courses/calendar';
import { getProgramSections, getPrograms, getProgramRequirements } from './cache';

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

export default router;
