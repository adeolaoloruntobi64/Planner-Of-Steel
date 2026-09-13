import { Router } from 'express';
import { buildPlan, type ProgramSelector } from './planner';
import type { TimePreference } from './courses/sections';
import type { Campus } from './courses/calendar';
import { getPrograms } from './programs/cache';
import { classifyProgramType, isValidCombo } from './programs/combos';

const VALID_TIME_PREFERENCES: TimePreference[] = ['morning', 'afternoon', 'evening', 'none'];

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
  const { completedCourses, programs, semesters, timePreference, allowConflicts } = req.body as {
    completedCourses?: string[];
    programs?: unknown[];
    semesters?: number;
    timePreference?: string;
    allowConflicts?: boolean;
  };

  if (!Array.isArray(completedCourses) || !Array.isArray(programs) || programs.length === 0 || !programs.every(isProgramSelector)) {
    res.status(400).json({
      error: 'completedCourses (array) and programs (non-empty array of {campus, sectionSlug, programCode}) are required',
    });
    return;
  }
  if (timePreference !== undefined && !VALID_TIME_PREFERENCES.includes(timePreference as TimePreference)) {
    res.status(400).json({ error: `timePreference must be one of ${VALID_TIME_PREFERENCES.join(', ')}` });
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
      ...(semesters !== undefined && { semesters }),
      ...(timePreference !== undefined && { timePreference: timePreference as TimePreference }),
      ...(allowConflicts !== undefined && { allowConflicts }),
    });
    res.json(plan);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
