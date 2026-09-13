import { useRef, useState } from 'react';
import { buildGroupPlan, type FriendInput, type GroupPlan } from '../../api';
import { StudentInputs, type StudentInputsHandle } from './StudentInputs';
import { PlanResults } from './PlanResults';

interface FriendSlot {
  id: string;
  name: string;
}

let nextId = 1;

export function GroupPlannerSection() {
  const [friends, setFriends] = useState<FriendSlot[]>([
    { id: String(nextId++), name: '' },
    { id: String(nextId++), name: '' },
  ]);
  const [validity, setValidity] = useState<Record<string, boolean>>({});
  const refs = useRef<Record<string, StudentInputsHandle | null>>({});

  const [constraintsPrompt, setConstraintsPrompt] = useState('');
  const [planToCompletion, setPlanToCompletion] = useState(true);
  const [semesters, setSemesters] = useState(2);

  const [status, setStatus] = useState<'idle' | 'parsing' | 'planning' | 'done' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [groupPlan, setGroupPlan] = useState<GroupPlan | null>(null);

  const namesFilled = friends.every((f) => f.name.trim().length > 0);
  const namesUnique = new Set(friends.map((f) => f.name.trim().toLowerCase())).size === friends.length;
  const allValid = friends.every((f) => validity[f.id]);
  const canSubmit = friends.length >= 2 && namesFilled && namesUnique && allValid && status !== 'parsing' && status !== 'planning';

  function addFriend() {
    setFriends([...friends, { id: String(nextId++), name: '' }]);
  }

  function removeFriend(id: string) {
    if (friends.length <= 2) return; // group planning needs at least 2 people
    setFriends(friends.filter((f) => f.id !== id));
    delete refs.current[id];
    setValidity((v) => {
      const next = { ...v };
      delete next[id];
      return next;
    });
  }

  function renameFriend(id: string, name: string) {
    setFriends(friends.map((f) => (f.id === id ? { ...f, name } : f)));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setGroupPlan(null);

    try {
      setStatus('parsing');
      const resolvedFriends: FriendInput[] = await Promise.all(
        friends.map(async (f) => {
          const resolved = await refs.current[f.id]!.resolve();
          return {
            name: f.name.trim(),
            completedCourses: resolved.completedCourses,
            inProgressCourses: resolved.inProgressCourses,
            programs: resolved.programs,
            ...(resolved.semestersElapsed !== undefined && { semestersElapsed: resolved.semestersElapsed }),
            ...(resolved.startSession !== undefined && { startSession: resolved.startSession }),
            ...(resolved.interests !== undefined && { interests: resolved.interests }),
          };
        })
      );

      setStatus('planning');
      const result = await buildGroupPlan({
        friends: resolvedFriends,
        ...(constraintsPrompt.trim() && { constraintsPrompt: constraintsPrompt.trim() }),
        ...(planToCompletion ? {} : { semesters }),
      });
      setGroupPlan(result);
      setStatus('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus('error');
    }
  }

  return (
    <div className="group-planner">
      <p className="hint">
        Each friend gets their own correct, independent plan — nothing bends one person's prerequisites or credit
        requirements to accommodate another. Describe any shared goals below (e.g. "Alex and Sam want to take a course
        together", "we want to maximize overlap in 3rd year fall") and matching suggestions will be layered on top.
      </p>

      <form onSubmit={handleSubmit}>
        {friends.map((f, i) => (
          <fieldset key={f.id} className="friend-card">
            <legend>
              Friend {i + 1}
              {friends.length > 2 && (
                <button type="button" className="remove" onClick={() => removeFriend(f.id)}>
                  Remove
                </button>
              )}
            </legend>
            <label>
              Name
              <input
                type="text"
                value={f.name}
                onChange={(e) => renameFriend(f.id, e.target.value)}
                placeholder="e.g. Alex"
                required
              />
            </label>
            <StudentInputs
              ref={(handle) => {
                refs.current[f.id] = handle;
              }}
              onValidityChange={(valid) => setValidity((v) => ({ ...v, [f.id]: valid }))}
            />
          </fieldset>
        ))}

        <button type="button" onClick={addFriend}>
          Add another friend
        </button>

        <fieldset>
          <legend>Shared goals</legend>
          <label>
            Anything you want to coordinate? (optional)
            <textarea
              value={constraintsPrompt}
              onChange={(e) => setConstraintsPrompt(e.target.value)}
              rows={2}
              placeholder='e.g. "Alex and Sam want to take a course together" or "maximize overlap in 3rd year fall"'
            />
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
              <input type="number" min={1} max={20} value={semesters} onChange={(e) => setSemesters(Number(e.target.value))} />
            </label>
          )}
        </fieldset>

        {!namesUnique && <p className="error">Friend names must be unique.</p>}

        <button type="submit" disabled={!canSubmit}>
          {status === 'parsing' ? 'Reading transcripts…' : status === 'planning' ? 'Building plans…' : 'Build our plans'}
        </button>
      </form>

      {error && <p className="error">{error}</p>}

      {groupPlan && (
        <div className="group-plan-results">
          {groupPlan.sharedSuggestions.length > 0 && (
            <div className="shared-suggestions">
              <h2>Shared suggestions</h2>
              <ul>
                {groupPlan.sharedSuggestions.map((s, i) => (
                  <li key={i}>
                    <strong>
                      {s.code}: {s.title}
                    </strong>
                    <p>{s.note}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {groupPlan.warnings.length > 0 && (
            <ul className="warnings">
              {groupPlan.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}

          {groupPlan.friends.map((f) => (
            <div key={f.name} className="friend-plan">
              <h2>{f.name}'s plan</h2>
              <PlanResults plan={f.plan} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
