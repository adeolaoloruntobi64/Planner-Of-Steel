import { Router } from 'express';
import multer from 'multer';
import { parseTranscript, parseTranscriptFromFile, type TranscriptFileKind } from './transcript';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

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

const FILE_KIND_BY_MIME: Record<string, TranscriptFileKind> = {
  'application/pdf': 'pdf',
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/webp': 'image',
  'image/gif': 'image',
};

router.post('/transcript/upload', upload.single('file'), async (req, res) => {
  const file = req.file;
  const { prompt } = req.body as { prompt?: string };

  if (!file) {
    res.status(400).json({ error: 'file is required (multipart field "file")' });
    return;
  }

  const kind = FILE_KIND_BY_MIME[file.mimetype];
  if (!kind) {
    res.status(400).json({ error: `Unsupported file type "${file.mimetype}". Upload a PDF, PNG, JPEG, WebP, or GIF.` });
    return;
  }

  try {
    const parsed = await parseTranscriptFromFile(file.buffer, file.mimetype, kind, prompt);
    res.json(parsed);
  } catch (err) {
    console.error('Failed to parse transcript file:', err);
    res.status(500).json({ error: 'Failed to parse transcript file' });
  }
});

export default router;
