import { Router } from 'express';
import { buildPlan, type ProgramSelector } from './planner';
import type { Session } from './courses/ttb';
import type { Campus } from './courses/calendar';
import { getPrograms } from './programs/cache';
import { classifyProgramType, isValidCombo } from './programs/combos';

function isCampus(value: unknown): value is Campus {
  return value === 'stgeorge' || value === 'utsc' || value === 'utm';
}

function isProgramSelector(value: unknown): value is ProgramSelector {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return isCampus(v.campus) && typeof v.sectionSlug === 'string' && typeof v.programCode === 'string';
}

const router = Router();

router.post('/', async (req, res) => {
  const { completedCourses, inProgressCourses, programs, semesters, semestersElapsed, startSession, interests } = req.body as {
    completedCourses?: string[];
    inProgressCourses?: string[];
    programs?: unknown[];
    semesters?: number;
    semestersElapsed?: number;
    startSession?: Session;
    interests?: string;
  };

  if (!Array.isArray(completedCourses) || !Array.isArray(programs) || programs.length === 0 || !programs.every(isProgramSelector)) {
    res.status(400).json({
      error: 'completedCourses (array) and programs (non-empty array of {campus, sectionSlug, programCode}) are required',
    });
    return;
  }
  if (startSession !== undefined && startSession !== 'F' && startSession !== 'S') {
    res.status(400).json({ error: 'startSession must be "F" or "S"' });
    return;
  }

  try {
    const summaries = await Promise.all(
      programs.map(async (p) => {
        const list = await getPrograms(p.campus, p.sectionSlug);
        return list.find((s) => s.code === p.programCode);
      })
    );
    const types = summaries.map((s) => (s ? classifyProgramType(s.name) : null));
    if (!isValidCombo(types)) {
      res.status(400).json({
        error:
          'That combination of programs isn’t a supported degree shape. Supported: 1 Specialist, 2 Specialists, ' +
          'Specialist + Major, Specialist + Minor, 2 Majors, or 1 Major + 2 Minors.',
      });
      return;
    }
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    return;
  }

  try {
    const plan = await buildPlan({
      completedCourses,
      programs,
      ...(inProgressCourses !== undefined && { inProgressCourses }),
      ...(semesters !== undefined && { semesters }),
      ...(semestersElapsed !== undefined && { semestersElapsed }),
      ...(startSession !== undefined && { startSession }),
      ...(interests !== undefined && { interests }),
    });
    res.json(plan);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
