import { useEffect, useState } from 'react';
import { getProgramSections, getPrograms, type Campus, type ProgramSection, type ProgramSummary } from '../../api';

const CAMPUS_LABELS: Record<Campus, string> = {
  stgeorge: 'St. George',
  utsc: 'Scarborough (UTSC)',
  utm: 'Mississauga (UTM)',
};

export interface ProgramSelection {
  campus: Campus;
  sectionSlug: string;
  programCode: string;
}

interface Props {
  value: Partial<ProgramSelection>;
  onChange: (value: Partial<ProgramSelection>) => void;
  onSummaryChange?: (summary: ProgramSummary | undefined) => void;
}

export function ProgramPicker({ value, onChange, onSummaryChange }: Props) {
  const [sections, setSections] = useState<ProgramSection[]>([]);
  const [sectionsLoading, setSectionsLoading] = useState(false);
  const [programs, setPrograms] = useState<ProgramSummary[]>([]);
  const [programsLoading, setProgramsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!value.campus) {
      setSections([]);
      return;
    }
    setSectionsLoading(true);
    setError(null);
    getProgramSections(value.campus)
      .then((s) => setSections([...s].sort((a, b) => a.name.localeCompare(b.name))))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setSectionsLoading(false));
  }, [value.campus]);

  useEffect(() => {
    if (!value.campus || !value.sectionSlug) {
      setPrograms([]);
      return;
    }
    setProgramsLoading(true);
    setError(null);
    getPrograms(value.campus, value.sectionSlug)
      .then(setPrograms)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setProgramsLoading(false));
  }, [value.campus, value.sectionSlug]);

  return (
    <div className="program-picker">
      <label>
        Campus
        <select
          value={value.campus ?? ''}
          onChange={(e) => {
            onChange({ campus: (e.target.value || undefined) as Campus | undefined, sectionSlug: undefined, programCode: undefined });
            onSummaryChange?.(undefined);
          }}
        >
          <option value="">Select a campus</option>
          {(Object.keys(CAMPUS_LABELS) as Campus[]).map((c) => (
            <option key={c} value={c}>
              {CAMPUS_LABELS[c]}
            </option>
          ))}
        </select>
      </label>

      <label>
        Subject area
        <select
          value={value.sectionSlug ?? ''}
          disabled={!value.campus || sectionsLoading}
          onChange={(e) => {
            onChange({ ...value, sectionSlug: e.target.value || undefined, programCode: undefined });
            onSummaryChange?.(undefined);
          }}
        >
          <option value="">{sectionsLoading ? 'Loading…' : 'Select a subject area'}</option>
          {sections.map((s) => (
            <option key={s.slug} value={s.slug}>
              {s.name}
            </option>
          ))}
        </select>
      </label>

      <label>
        Program
        <select
          value={value.programCode ?? ''}
          disabled={!value.sectionSlug || programsLoading}
          onChange={(e) => {
            const code = e.target.value || undefined;
            onChange({ ...value, programCode: code });
            onSummaryChange?.(programs.find((p) => p.code === code));
          }}
        >
          <option value="">{programsLoading ? 'Loading…' : 'Select a program'}</option>
          {programs.map((p) => (
            <option key={p.code} value={p.code}>
              {p.name}
            </option>
          ))}
        </select>
      </label>

      {value.programCode && (
        <p className="selected-program-name">
          Selected: <strong>{programs.find((p) => p.code === value.programCode)?.name ?? value.programCode}</strong>
        </p>
      )}

      {error && <p className="error">{error}</p>}
    </div>
  );
}
