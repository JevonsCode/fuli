import { withoutControls } from '../text/control-characters.js';
import { singleLineExcerpt } from '../text/single-line.js';

// What the desktop client's tray menu shows of FULI's work without opening the
// window: the assistants that worked in the last 24 hours, one row each (the
// ones at work now first), and the roundtable threads under way. An assistant
// works wherever a client session begins a task as it, so the rows come from
// the task entries, not from the task board. A day is dozens of entries, so the
// menu gets the few rows it can hold and how many more there are, never the
// history. An assistant's row also names the project of the task it is on and
// a short title of it (its board task's, else the first line of its work
// summary; no prompt is kept), shown only in this computer's own menu, never
// logged. Each row names the console page it opens as a fuli:// link.

const WINDOW_MS = 24 * 60 * 60 * 1000;
const THREADS_READ = 30;
const ASSISTANT_ROWS = 5;
const ROUNDTABLE_ROWS = 3;
const SUBJECT_CHARS = 60;
const NAME_CHARS = 32;
const WAITING_NAMES = 2;
const ALL_ASSISTANTS = 'fuli://project-agents';
const ALL_ROUNDTABLES = 'fuli://roundtables';

export async function desktopGlance({ app, now = Date.now }) {
  const personalSpaceId = app.config?.personal?.spaceId ?? null;
  if (!personalSpaceId) return { assistants: section([], 0, ALL_ASSISTANTS), roundtables: section([], 0, ALL_ROUNDTABLES) };
  const since = new Date(now() - WINDOW_MS).toISOString();
  // The two sections are read apart: the roundtable is local, so a Provider
  // that is down or failing empties only the assistants.
  const [assistants, roundtables] = await Promise.all([
    assistantsSection(app, personalSpaceId, since).catch(() => section([], 0, ALL_ASSISTANTS)),
    roundtablesSection(app, since).catch(() => section([], 0, ALL_ROUNDTABLES))
  ]);
  return { assistants, roundtables };
}

async function assistantsSection(app, personalSpaceId, since) {
  const worked = await app.personal.recentWorkingAgents({ personalSpaceId, since });
  // At work now first; within each, the latest first as the Provider sent them.
  const ordered = [...worked.filter((agent) => agent.working), ...worked.filter((agent) => !agent.working)];
  // One read names every row's project; without it the rows keep their names.
  const [{ rows, read }, projectName] = await Promise.all([
    named(app, personalSpaceId, ordered),
    ordered.length ? projectNames(app, personalSpaceId) : () => null
  ]);
  return section(rows.map(({ projectId, ...row }) => ({ ...row, project: projectName(projectId) })),
    ordered.length - read, ALL_ASSISTANTS);
}

// A project's shown name by its id; null for one that cannot be read.
async function projectNames(app, personalSpaceId) {
  let projects = [];
  try {
    projects = await app.listPersonalProjects({ personalSpaceId });
  } catch {
    // The rows keep their names and tasks.
  }
  const names = new Map(projects.map((project) => [project.project_id, shownText(project.profile?.name, NAME_CHARS)]));
  return (projectId) => names.get(projectId) || null;
}

async function roundtablesSection(app, since) {
  const talking = (app.roundtable?.threads({ limit: THREADS_READ }).threads ?? [])
    .filter((thread) => thread.waiting && Date.parse(thread.updatedAt) >= Date.parse(since));
  return section(talking.slice(0, ROUNDTABLE_ROWS).map((thread) => ({
    subject: shownText(thread.subject, SUBJECT_CHARS),
    replying: thread.replying,
    waitingFor: waitingNames(thread.waitingFor),
    link: `fuli://roundtables/${encodeURIComponent(thread.id)}`
  })), talking.length - Math.min(talking.length, ROUNDTABLE_ROWS), ALL_ROUNDTABLES);
}

// The rows the menu holds, how many were past them, and the page of them all.
const section = (rows, more, link) => ({ rows, more, link });

// A menu label is one short line a person can read: names come from profiles an
// Agent wrote and from paired computers, so line breaks, tabs (a shortcut column
// on Windows), hidden or reordering characters and length are taken out here.
const shownText = (value, limit) => singleLineExcerpt(withoutControls(value), limit);

// Who a thread waits for: the first names and how many more.
function waitingNames(names) {
  const readable = (Array.isArray(names) ? names : []).map((name) => shownText(name, NAME_CHARS)).filter(Boolean);
  return readable.length > WAITING_NAMES
    ? [...readable.slice(0, WAITING_NAMES), `+${readable.length - WAITING_NAMES}`]
    : readable;
}

// Up to ASSISTANT_ROWS rows with their assistants' shown names, in order. An
// assistant that cannot be read has no name to show and no page to open, so
// the next one takes its row. read: how many of the list were looked at.
async function named(app, personalSpaceId, agents) {
  const rows = [];
  let read = 0;
  while (rows.length < ASSISTANT_ROWS && read < agents.length) {
    const batch = agents.slice(read, read + ASSISTANT_ROWS - rows.length);
    read += batch.length;
    const records = await Promise.allSettled(batch.map((agent) =>
      app.getProjectAgent({ personalSpaceId, personalProjectId: null, agentId: agent.agent_id })));
    batch.forEach((agent, index) => {
      const profile = records[index].status === 'fulfilled' ? records[index].value.profile : null;
      const name = shownText(profile?.displayName || profile?.name, NAME_CHARS);
      if (name) rows.push({ name, projectId: agent.personal_project_id ?? null, task: shownText(agent.title, SUBJECT_CHARS) || null,
        working: agent.working, at: agent.last_active,
        link: `fuli://agents/${encodeURIComponent(personalSpaceId)}/${encodeURIComponent(agent.agent_id)}` });
    });
  }
  return { rows, read };
}
