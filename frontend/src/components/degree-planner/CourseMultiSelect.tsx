import { useEffect, useState } from 'react';
import { getProgramCourses, type CourseOption, type ProgramSelector } from '../../api';

interface Props {
  programs: ProgramSelector[];
  value: string[];
  onChange: (codes: string[]) => void;
}

export function CourseMultiSelect({ programs, value, onChange }: Props) {
  const [options, setOptions] = useState<CourseOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (programs.length === 0) {
      setOptions([]);
      return;
    }
    setLoading(true);
    setError(null);
    Promise.all(programs.map((p) => getProgramCourses(p.campus, p.sectionSlug, p.programCode)))
      .then((lists) => {
        const merged = new Map<string, CourseOption>();
        for (const list of lists) for (const c of list) merged.set(c.code, c);
        setOptions([...merged.values()].sort((a, b) => a.code.localeCompare(b.code)));
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [programs]);

  function toggle(code: string) {
    onChange(value.includes(code) ? value.filter((c) => c !== code) : [...value, code]);
  }

  if (programs.length === 0) {
    return <p className="hint">Add a program above first so courses can be listed here.</p>;
  }

  const filtered = options.filter(
    (o) => o.code.toLowerCase().includes(search.toLowerCase()) || o.title.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="course-multi-select">
      {loading && <p className="hint">Loading courses…</p>}
      {error && <p className="error">{error}</p>}
      {!loading && !error && (
        <>
          <input
            type="text"
            placeholder="Search courses…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="course-checkbox-list">
            {filtered.map((o) => (
              <label key={o.code} className="course-checkbox">
                <input type="checkbox" checked={value.includes(o.code)} onChange={() => toggle(o.code)} />
                <strong>{o.code}</strong> {o.title}
              </label>
            ))}
            {filtered.length === 0 && <p className="hint">No courses match "{search}".</p>}
          </div>
          {value.length > 0 && <p className="hint">{value.length} course(s) selected.</p>}
        </>
      )}
    </div>
  );
}
