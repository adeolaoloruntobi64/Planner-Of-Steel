import { Router } from 'express';
import { getCourseInfo, warmCache, cacheStatus } from './cache';
import { retrieveTree } from './retrieveTree';
import { getCourseOfferings } from './ttb';

const router = Router();

router.get('/:code/offerings', async (req, res) => {
  try {
    const offerings = await getCourseOfferings(req.params.code);
    res.json(offerings);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.get('/:code/tree', async (req, res) => {
  const maxDepth = req.query.maxDepth ? Number(req.query.maxDepth) : undefined;
  try {
    const tree = await retrieveTree(req.params.code, maxDepth);
    res.json(tree);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.get('/:code', async (req, res) => {
  try {
    const info = await getCourseInfo(req.params.code);
    res.json(info);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.post('/warm', async (req, res) => {
  const { codes } = req.body as { codes?: string[] };
  if (!Array.isArray(codes) || codes.length === 0) {
    res.status(400).json({ error: 'codes must be a non-empty array of course codes' });
    return;
  }
  const result = await warmCache(codes);
  res.json(result);
});

router.get('/', (_req, res) => {
  res.json(cacheStatus());
});

export default router;
