import type { DegreePlan } from '../../api';

const SESSION_LABELS: Record<string, string> = { F: 'Fall', S: 'Winter', Y: 'Fall/Winter' };

interface Props {
  plan: DegreePlan;
}

export function PlanResults({ plan }: Props) {
  return (
    <div className="plan-results">
      <h2>{plan.programs.join(' + ')}</h2>

      {plan.warnings.length > 0 && (
        <ul className="warnings">
          {plan.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}

      <div className="semesters">
        {plan.semesters.map((semester) => (
          <div key={semester.index} className="semester-card">
            <h3>
              Semester {semester.index} — {SESSION_LABELS[semester.session] ?? semester.session}
            </h3>
            {semester.courses.length === 0 ? (
              <p className="empty">No courses placed this semester.</p>
            ) : (
              <ul className="courses">
                {semester.courses.map((course) => (
                  <li key={course.code} className="course">
                    <div className="course-header">
                      <strong>{course.code}</strong> <span className="credit">({course.credit} credit)</span>
                    </div>
                    <div className="course-title">{course.title}</div>
                    {course.sections && course.sections.length > 0 && (
                      <ul className="sections">
                        {course.sections.map((s) => (
                          <li key={s.code} className={s.conflictsWith.length > 0 ? 'conflict' : ''}>
                            {s.type} {s.code}
                            {s.conflictsWith.length > 0 && <span className="conflict-note"> conflicts with {s.conflictsWith.join(', ')}</span>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>

      {plan.stillNeeded.length > 0 && (
        <div className="still-needed">
          <h3>Still needed</h3>
          <p>{plan.stillNeeded.join(', ')}</p>
        </div>
      )}

      {plan.electiveGroupsRemaining.length > 0 && (
        <div className="still-needed">
          <h3>Elective choices remaining</h3>
          <ul>
            {plan.electiveGroupsRemaining.map((g) => (
              <li key={g.description}>
                {g.description}: choose {g.stillNeed} more from {g.options.join(', ')}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
