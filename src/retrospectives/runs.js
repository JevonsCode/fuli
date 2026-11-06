import { RETROSPECTIVE_OPERATION } from './run.js';

// The retrospective runs in the built-in Agents' suggestion log, read through
// the read that refreshes the recovery gate, as the console reads the log.
export async function retrospectiveRuns(app) {
  const rows = app.roleSuggestions ? await app.readRoleSuggestions({ limit: 300 }) : [];
  return rows.filter(row => row.operation === RETROSPECTIVE_OPERATION);
}

// What a task's view shows: its newest written retrospective, else its newest
// attempt's status. A permanent delete took the words of a row written before it.
export async function taskRetrospective(app, taskId) {
  const rows = (await retrospectiveRuns(app)).filter(row => row.subject?.taskId === taskId);
  const row = rows.find(entry => entry.status === 'written') ?? rows[0];
  if (!row) return null;
  return { at: row.at, status: row.status, summary: row.hint ?? null, problems: row.issues ?? [],
    lessons: (row.lessons ?? []).map(lesson => ({ title: lesson.title, status: lesson.status })), wordsRemoved: Boolean(row.hard_deleted) };
}
