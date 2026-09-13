import type { DegreePlan, PlacementCategory } from '../../api';
import { Collapsible } from './Collapsible';

const SESSION_LABELS: Record<string, string> = { F: 'Fall', S: 'Winter', Y: 'Fall/Winter', SU: 'Summer' };

const CATEGORY_LABELS: Partial<Record<PlacementCategory, string>> = {
  elective: 'Elective choice — swap freely',
  breadth: 'Breadth requirement — swap freely',
  interest: 'Matches your interest — swap freely',
  'free-elective': 'Open elective — pick anything',
};

interface Props {
  plan: DegreePlan;
}

export function PlanResults({ plan }: Props) {
  const { completed, inProgress } = plan.history;

  return (
    <div className="plan-results">
      <h2>{plan.programs.join(' + ')}</h2>

      {plan.warnings.length > 0 && (
        <Collapsible className="warnings-collapsible" summary={`⚠ ${plan.warnings.length} warning${plan.warnings.length === 1 ? '' : 's'}`}>
          <ul className="warnings">
            {plan.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </Collapsible>
      )}

      {(completed.length > 0 || inProgress.length > 0) && (
        <div className="history-section">
          {completed.length > 0 && (
            <div className="course-chip-group completed">
              <h3>Completed</h3>
              <div className="chip-list">
                {completed.map((c) => (
                  <span key={c} className="course-chip completed">
                    {c}
                  </span>
                ))}
              </div>
            </div>
          )}
          {inProgress.length > 0 && (
            <div className="course-chip-group in-progress">
              <h3>In Progress</h3>
              <div className="chip-list">
                {inProgress.map((c) => (
                  <span key={c} className="course-chip in-progress">
                    {c}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {plan.semesters.length > 0 && (
        <div className="future-section">
          <h3>Future</h3>
          <div className="semesters">
            {plan.semesters.map((semester) => (
              <div
                key={semester.index}
                className={
                  semester.type === 'work' ? 'semester-card work-semester' : semester.type === 'break' ? 'semester-card break-semester' : 'semester-card'
                }
              >
                <h4>
                  Semester {semester.index} — {SESSION_LABELS[semester.session] ?? semester.session}
                  {semester.type === 'work' ? ' (Work Term)' : semester.type === 'break' ? ' (break)' : ''}
                </h4>
                {semester.type === 'break' ? (
                  <p className="empty">
                    Skipped by default — check "Take courses in summer semesters" in Preferences to plan courses here instead.
                  </p>
                ) : semester.courses.length === 0 ? (
                  <p className="empty">No courses placed this semester.</p>
                ) : (
                  <ul className="courses">
                    {semester.courses.map((course) => (
                      <li key={course.code} className="course">
                        <div className="course-header">
                          <strong>{course.code}</strong> <span className="credit">({course.credit} credit)</span>
                        </div>
                        <div className="course-title">{course.title}</div>
                        {CATEGORY_LABELS[course.category] && <span className="category-badge">{CATEGORY_LABELS[course.category]}</span>}
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
        </div>
      )}

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
