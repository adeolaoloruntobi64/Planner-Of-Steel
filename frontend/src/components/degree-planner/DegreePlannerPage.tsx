import { useRef, useState } from 'react';
import { buildPlan, type DegreePlan } from '../../api';
import { PlanResults } from './PlanResults';
import { StudentInputs, type StudentInputsHandle } from './StudentInputs';
import { GroupPlannerSection } from './GroupPlannerSection';

type PlannerMode = 'solo' | 'group';

export function DegreePlannerPage() {
  const [mode, setMode] = useState<PlannerMode>('solo');

  const studentRef = useRef<StudentInputsHandle>(null);
  const [studentValid, setStudentValid] = useState(false);

  const [planToCompletion, setPlanToCompletion] = useState(true);
  const [semesters, setSemesters] = useState(2);
  const [includeSummers, setIncludeSummers] = useState(false);

  const [status, setStatus] = useState<'idle' | 'parsing' | 'planning' | 'done' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [recognized, setRecognized] = useState<string[] | null>(null);
  const [plan, setPlan] = useState<DegreePlan | null>(null);

  const canSubmit = studentValid && status !== 'parsing' && status !== 'planning';

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPlan(null);

    try {
      setStatus('parsing');
      const resolved = await studentRef.current!.resolve();
      setRecognized(resolved.recognized);

      setStatus('planning');
      const result = await buildPlan({
        completedCourses: resolved.completedCourses,
        inProgressCourses: resolved.inProgressCourses,
        programs: resolved.programs,
        ...(planToCompletion ? {} : { semesters }),
        ...(resolved.semestersElapsed !== undefined && { semestersElapsed: resolved.semestersElapsed }),
        ...(resolved.startSession !== undefined && { startSession: resolved.startSession }),
        ...(resolved.interests !== undefined && { interests: resolved.interests }),
        includeSummers,
      });
      setPlan(result);
      setStatus('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus('error');
    }
  }

  return (
    <div className="degree-planner-page">
      <h1>Degree Planner</h1>

      <div className="mode-tabs top-level-mode">
        <button type="button" className={mode === 'solo' ? 'active' : ''} onClick={() => setMode('solo')}>
          Just me
        </button>
        <button type="button" className={mode === 'group' ? 'active' : ''} onClick={() => setMode('group')}>
          With friends
        </button>
      </div>

      {mode === 'group' ? (
        <GroupPlannerSection />
      ) : (
        <>
          <form onSubmit={handleSubmit}>
            <StudentInputs ref={studentRef} onValidityChange={setStudentValid} />

            <fieldset>
              <legend>Preferences</legend>
              <label className="checkbox">
                <input type="checkbox" checked={planToCompletion} onChange={(e) => setPlanToCompletion(e.target.checked)} />
                Plan all the way to program completion
              </label>
              {!planToCompletion && (
                <label>
                  Semesters to plan
                  <input
                    type="number"
                    min={1}
                    max={20}
                    value={semesters}
                    onChange={(e) => setSemesters(Number(e.target.value))}
                  />
                </label>
              )}
              <label className="checkbox">
                <input type="checkbox" checked={includeSummers} onChange={(e) => setIncludeSummers(e.target.checked)} />
                Take courses in summer semesters
              </label>
              <p className="hint">
                Off by default — summers still show up in the plan as an explicit break so you know they're there; check
                this to actually schedule courses in them instead.
              </p>
            </fieldset>

            <button type="submit" disabled={!canSubmit}>
              {status === 'parsing' ? 'Reading transcript…' : status === 'planning' ? 'Building plan…' : 'Build my plan'}
            </button>
          </form>

          {error && <p className="error">{error}</p>}

          {recognized && recognized.length > 0 && <p className="completed-summary">Recognized: {recognized.join(', ')}</p>}

          {plan && <PlanResults plan={plan} />}
        </>
      )}
    </div>
  );
}
