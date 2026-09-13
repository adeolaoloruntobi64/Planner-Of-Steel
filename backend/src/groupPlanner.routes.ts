import { Router } from 'express';
import { buildGroupPlan, type FriendInput } from './groupPlanner';
import type { ProgramSelector } from './planner';
import type { Campus } from './courses/calendar';

function isCampus(value: unknown): value is Campus {
  return value === 'stgeorge' || value === 'utsc' || value === 'utm';
}

function isProgramSelector(value: unknown): value is ProgramSelector {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return isCampus(v.campus) && typeof v.sectionSlug === 'string' && typeof v.programCode === 'string';
}

function isFriendInput(value: unknown): value is FriendInput {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.name === 'string' &&
    v.name.length > 0 &&
    Array.isArray(v.completedCourses) &&
    Array.isArray(v.programs) &&
    v.programs.length > 0 &&
    v.programs.every(isProgramSelector)
  );
}

const router = Router();

router.post('/', async (req, res) => {
  const { friends, constraintsPrompt, semesters, includeSummers } = req.body as {
    friends?: unknown[];
    constraintsPrompt?: string;
    semesters?: number;
    includeSummers?: boolean;
  };

  if (!Array.isArray(friends) || friends.length < 2 || !friends.every(isFriendInput)) {
    res.status(400).json({
      error: 'friends (array of at least 2 {name, completedCourses, programs, ...}) is required',
    });
    return;
  }

  try {
    const plan = await buildGroupPlan({
      friends,
      ...(constraintsPrompt !== undefined && { constraintsPrompt }),
      ...(semesters !== undefined && { semesters }),
      ...(includeSummers !== undefined && { includeSummers }),
    });
    res.json(plan);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
