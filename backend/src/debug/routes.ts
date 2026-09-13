import { Router } from 'express';
import { getStatus } from './status';

const router = Router();

router.get('/status', (_req, res) => {
  res.json(getStatus());
});

export default router;
