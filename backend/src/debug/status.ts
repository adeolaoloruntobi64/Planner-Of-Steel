interface Step {
  label: string;
  startedAt: number;
}

const stack: Step[] = [];

/**
 * Marks a long-running operation as in progress for the lifetime of the returned callback.
 * Nest calls to get a breadcrumb trail (e.g. "Building plan" > "Checking offerings for CSCA08H3").
 * Usage: `const done = pushStep('...'); try { ... } finally { done(); }`
 */
export function pushStep(label: string): () => void {
  const step: Step = { label, startedAt: Date.now() };
  stack.push(step);
  return () => {
    const index = stack.indexOf(step);
    if (index !== -1) stack.splice(index, 1);
  };
}

export interface DebugStatus {
  active: boolean;
  steps: { label: string; runningForMs: number }[];
}

/** Returns what's currently in progress, or an idle status if nothing is. */
export function getStatus(): DebugStatus {
  if (stack.length === 0) return { active: false, steps: [] };
  const now = Date.now();
  return {
    active: true,
    steps: stack.map((s) => ({ label: s.label, runningForMs: now - s.startedAt })),
  };
}
