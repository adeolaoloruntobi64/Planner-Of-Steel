import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { parseTranscript, uploadTranscriptFile, type ProgramSelector, type ProgramSummary } from '../../api';
import { ProgramPicker, type ProgramSelection } from './ProgramPicker';
import { CourseMultiSelect } from './CourseMultiSelect';
import { classifyProgramType, comboGuidance, isValidCombo, typeLabel, type ProgramType } from './programCombos';

export interface AddedProgram extends ProgramSelection {
  name: string;
  type: ProgramType | null;
}

type CompletionMode = 'paste' | 'upload' | 'manual';

export interface ResolvedStudentInput {
  programs: ProgramSelector[];
  completedCourses: string[];
  inProgressCourses: string[];
  semestersElapsed?: number;
  startSession?: 'F' | 'S';
  interests?: string;
  /** Everything the student is recognized as having completed/in-progress, for display. */
  recognized: string[];
}

export interface StudentInputsHandle {
  /** Runs any needed transcript parsing and returns the resolved plan input. Throws on failure. */
  resolve(): Promise<ResolvedStudentInput>;
}

interface Props {
  /** Called whenever this student's program selection becomes valid/invalid, so a parent form can gate its submit button without lifting all the state up. */
  onValidityChange?: (valid: boolean) => void;
}

function isComplete(p: Partial<ProgramSelection>): p is ProgramSelection {
  return !!(p.campus && p.sectionSlug && p.programCode);
}

/**
 * The full "which program(s), what have you completed, any interests" input block — shared by
 * the solo planner and each friend card in group-planning mode, so the two stay in sync instead
 * of drifting apart as separate copies.
 */
export const StudentInputs = forwardRef<StudentInputsHandle, Props>(function StudentInputs({ onValidityChange }, ref) {
  const [draftProgram, setDraftProgram] = useState<Partial<ProgramSelection>>({});
  const [draftSummary, setDraftSummary] = useState<ProgramSummary | undefined>();
  const [programs, setPrograms] = useState<AddedProgram[]>([]);

  const [completionMode, setCompletionMode] = useState<CompletionMode>('paste');
  const [transcriptText, setTranscriptText] = useState('');
  const [transcriptFile, setTranscriptFile] = useState<File | null>(null);
  const [selectedCourses, setSelectedCourses] = useState<string[]>([]);
  const [prompt, setPrompt] = useState('');

  const draftAsAdded: AddedProgram | null =
    isComplete(draftProgram) && draftSummary && !programs.some((p) => p.programCode === draftProgram.programCode)
      ? { ...draftProgram, name: draftSummary.name, type: classifyProgramType(draftSummary.name) }
      : null;
  const effectivePrograms = draftAsAdded ? [...programs, draftAsAdded] : programs;
  const comboValid = isValidCombo(effectivePrograms.map((p) => p.type));

  useEffect(() => {
    onValidityChange?.(effectivePrograms.length > 0 && comboValid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectivePrograms.length, comboValid]);

  function addProgram() {
    if (!isComplete(draftProgram) || !draftSummary) return;
    if (programs.some((p) => p.programCode === draftProgram.programCode)) return;
    setPrograms([...programs, { ...draftProgram, name: draftSummary.name, type: classifyProgramType(draftSummary.name) }]);
    setDraftProgram({});
    setDraftSummary(undefined);
  }

  function removeProgram(programCode: string) {
    setPrograms(programs.filter((p) => p.programCode !== programCode));
  }

  useImperativeHandle(ref, () => ({
    async resolve() {
      const finalPrograms = draftAsAdded ? [...programs, draftAsAdded] : programs;
      if (finalPrograms.length === 0 || !isValidCombo(finalPrograms.map((p) => p.type))) {
        throw new Error('Add a valid program combination before building a plan.');
      }
      const programSelectors: ProgramSelector[] = finalPrograms.map(({ campus, sectionSlug, programCode }) => ({ campus, sectionSlug, programCode }));

      let completed: string[] = [];
      let inProgress: string[] = [];
      let semestersElapsed: number | undefined;
      let startSession: 'F' | 'S' | undefined;

      if (completionMode === 'manual') {
        completed = selectedCourses;
      } else if (completionMode === 'upload' && transcriptFile) {
        const parsed = await uploadTranscriptFile(transcriptFile, prompt || undefined);
        completed = parsed.completedCourses;
        inProgress = parsed.inProgressCourses;
        semestersElapsed = parsed.semestersElapsed;
        startSession = parsed.nextSession;
      } else if (completionMode === 'paste' && transcriptText.trim()) {
        const parsed = await parseTranscript(transcriptText, prompt || undefined);
        completed = parsed.completedCourses;
        inProgress = parsed.inProgressCourses;
        semestersElapsed = parsed.semestersElapsed;
        startSession = parsed.nextSession;
      }

      return {
        programs: programSelectors,
        completedCourses: completed,
        inProgressCourses: inProgress,
        ...(semestersElapsed !== undefined && { semestersElapsed }),
        ...(startSession !== undefined && { startSession }),
        ...(prompt.trim() && { interests: prompt.trim() }),
        recognized: [...completed, ...inProgress],
      };
    },
  }));

  return (
    <>
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
        <div className="mode-tabs">
          <button type="button" className={completionMode === 'paste' ? 'active' : ''} onClick={() => setCompletionMode('paste')}>
            Paste transcript
          </button>
          <button type="button" className={completionMode === 'upload' ? 'active' : ''} onClick={() => setCompletionMode('upload')}>
            Upload transcript
          </button>
          <button type="button" className={completionMode === 'manual' ? 'active' : ''} onClick={() => setCompletionMode('manual')}>
            Select courses
          </button>
        </div>

        {completionMode === 'paste' && (
          <label>
            Paste your unofficial transcript, or just describe what you've taken
            <textarea
              value={transcriptText}
              onChange={(e) => setTranscriptText(e.target.value)}
              placeholder="e.g. I've completed CSCA08H3 and MATA31H3 at UTSC..."
              rows={6}
            />
          </label>
        )}

        {completionMode === 'upload' && (
          <label>
            Upload a transcript (PDF, PNG, JPEG, WebP, or GIF)
            <input
              type="file"
              accept=".pdf,application/pdf,.png,image/png,.jpg,.jpeg,image/jpeg,.webp,image/webp,.gif,image/gif"
              onChange={(e) => setTranscriptFile(e.target.files?.[0] ?? null)}
            />
            {transcriptFile && <span className="hint">Selected: {transcriptFile.name}</span>}
          </label>
        )}

        {completionMode === 'manual' && (
          <CourseMultiSelect programs={effectivePrograms} value={selectedCourses} onChange={setSelectedCourses} />
        )}

        <label>
          Anything else? (target graduation, planned breaks, career interests — e.g. "cybersecurity and robotics")
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={2} />
        </label>
        <p className="hint">
          Stated interests help pick between elective options where there's a choice — mention more than one and both get
          weighed, not just whichever the model likes best. Leave blank for a broad, well-rounded selection.
        </p>
      </fieldset>
    </>
  );
});
