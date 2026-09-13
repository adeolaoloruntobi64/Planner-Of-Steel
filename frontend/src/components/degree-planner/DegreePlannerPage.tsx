import { useState } from 'react';
import { buildPlan, parseTranscript, type DegreePlan, type ProgramSummary, type TimePreference } from '../../api';
import { ProgramPicker, type ProgramSelection } from './ProgramPicker';
import { PlanResults } from './PlanResults';
import { classifyProgramType, comboGuidance, isValidCombo, typeLabel, type ProgramType } from './programCombos';

const TIME_PREFERENCES: { value: TimePreference; label: string }[] = [
  { value: 'none', label: 'No preference' },
  { value: 'morning', label: 'Mostly mornings' },
  { value: 'afternoon', label: 'Mostly afternoons' },
  { value: 'evening', label: 'Mostly evenings' },
];

interface AddedProgram extends ProgramSelection {
  name: string;
  type: ProgramType | null;
}

function isComplete(p: Partial<ProgramSelection>): p is ProgramSelection {
  return !!(p.campus && p.sectionSlug && p.programCode);
}

export function DegreePlannerPage() {
  const [draftProgram, setDraftProgram] = useState<Partial<ProgramSelection>>({});
  const [draftSummary, setDraftSummary] = useState<ProgramSummary | undefined>();
  const [programs, setPrograms] = useState<AddedProgram[]>([]);
  const [transcriptText, setTranscriptText] = useState('');
  const [prompt, setPrompt] = useState('');
  const [planToCompletion, setPlanToCompletion] = useState(true);
  const [semesters, setSemesters] = useState(2);
  const [timePreference, setTimePreference] = useState<TimePreference>('none');
  const [allowConflicts, setAllowConflicts] = useState(false);

  const [status, setStatus] = useState<'idle' | 'parsing' | 'planning' | 'done' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [completedCourses, setCompletedCourses] = useState<string[] | null>(null);
  const [plan, setPlan] = useState<DegreePlan | null>(null);

  // Include the in-progress picker selection (if complete but not yet "added") so the submit
  // button reflects what would actually be submitted — clicking "Add program" first isn't required.
  const draftAsAdded: AddedProgram | null =
    isComplete(draftProgram) && draftSummary && !programs.some((p) => p.programCode === draftProgram.programCode)
      ? { ...draftProgram, name: draftSummary.name, type: classifyProgramType(draftSummary.name) }
      : null;
  const effectivePrograms = draftAsAdded ? [...programs, draftAsAdded] : programs;

  const comboValid = isValidCombo(effectivePrograms.map((p) => p.type));
  const canSubmit = effectivePrograms.length > 0 && comboValid && status !== 'parsing' && status !== 'planning';

  function addProgram() {
    if (!isComplete(draftProgram) || !draftSummary) return;
    if (programs.some((p) => p.programCode === draftProgram.programCode)) return; // already added
    setPrograms([...programs, { ...draftProgram, name: draftSummary.name, type: classifyProgramType(draftSummary.name) }]);
    setDraftProgram({});
    setDraftSummary(undefined);
  }

  function removeProgram(programCode: string) {
    setPrograms(programs.filter((p) => p.programCode !== programCode));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // The picker's in-progress selection counts even if "Add program" was never clicked.
    const finalPrograms = effectivePrograms;
    if (draftAsAdded) {
      setPrograms(finalPrograms);
      setDraftProgram({});
      setDraftSummary(undefined);
    }
    if (finalPrograms.length === 0 || !isValidCombo(finalPrograms.map((p) => p.type))) return;

    setError(null);
    setPlan(null);

    try {
      let completed: string[] = [];
      if (transcriptText.trim()) {
        setStatus('parsing');
        const parsed = await parseTranscript(transcriptText, prompt || undefined);
        completed = parsed.completedCourses;
        setCompletedCourses(completed);
      } else {
        setCompletedCourses([]);
      }

      setStatus('planning');
      const result = await buildPlan({
        completedCourses: completed,
        programs: finalPrograms.map(({ campus, sectionSlug, programCode }) => ({ campus, sectionSlug, programCode })),
        ...(planToCompletion ? {} : { semesters }),
        timePreference,
        allowConflicts,
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

      <form onSubmit={handleSubmit}>
        <fieldset>
          <legend>Programs</legend>
          <p className="hint">
            Supported combinations: 1 Specialist, 2 Specialists (double degree), Specialist + Major, Specialist + Minor,
            2 Majors, or 1 Major + 2 Minors.
          </p>

          {programs.length > 0 && (
            <ul className="program-list">
              {programs.map((p) => (
                <li key={p.programCode}>
                  <span>
                    <span className="type-badge">{typeLabel(p.type)}</span> {p.name}
                  </span>
                  <button type="button" className="remove" onClick={() => removeProgram(p.programCode)}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}

          <p className={comboValid ? 'combo-status valid' : 'combo-status'}>{comboGuidance(effectivePrograms.map((p) => p.type))}</p>

          <ProgramPicker value={draftProgram} onChange={setDraftProgram} onSummaryChange={setDraftSummary} />
          <button type="button" onClick={addProgram} disabled={!isComplete(draftProgram) || !draftSummary}>
            Add program
          </button>
        </fieldset>

        <fieldset>
          <legend>What have you completed?</legend>
          <label>
            Paste your unofficial transcript, or just describe what you've taken
            <textarea
              value={transcriptText}
              onChange={(e) => setTranscriptText(e.target.value)}
              placeholder="e.g. I've completed CSCA08H3 and MATA31H3 at UTSC..."
              rows={6}
            />
          </label>
          <label>
            Anything else? (target graduation, planned breaks, preferences)
            <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={2} />
          </label>
        </fieldset>

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
          <label>
            Time of day preference (next semester only)
            <select value={timePreference} onChange={(e) => setTimePreference(e.target.value as TimePreference)}>
              {TIME_PREFERENCES.map((tp) => (
                <option key={tp.value} value={tp.value}>
                  {tp.label}
                </option>
              ))}
            </select>
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={allowConflicts} onChange={(e) => setAllowConflicts(e.target.checked)} />
            Allow overlapping sections if that's the only way to get my preferred times
          </label>
        </fieldset>

        <button type="submit" disabled={!canSubmit}>
          {status === 'parsing' ? 'Reading transcript…' : status === 'planning' ? 'Building plan…' : 'Build my plan'}
        </button>
      </form>

      {error && <p className="error">{error}</p>}

      {completedCourses && completedCourses.length > 0 && (
        <p className="completed-summary">Recognized as completed: {completedCourses.join(', ')}</p>
      )}

      {plan && <PlanResults plan={plan} />}
    </div>
  );
}
