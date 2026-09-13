import { Router } from 'express';
import { parseTranscript } from './transcript';

const router = Router();

router.post('/transcript', async (req, res) => {
  const { transcriptText, prompt } = req.body as { transcriptText?: string; prompt?: string };

  if (!transcriptText || typeof transcriptText !== 'string') {
    res.status(400).json({ error: 'transcriptText is required' });
    return;
  }

  try {
    const parsed = await parseTranscript(transcriptText, prompt);
    res.json(parsed);
  } catch (err) {
    console.error('Failed to parse transcript:', err);
    res.status(500).json({ error: 'Failed to parse transcript' });
  }
});

export default router;
