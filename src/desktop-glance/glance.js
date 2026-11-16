import { singleLineExcerpt } from '../text/single-line.js';

// What the desktop client's tray menu shows of FULI's work without opening the
// window: the assistants that worked in the last 24 hours, one row each (the
// ones at work now first), and the roundtable threads under way. An assistant
// works wherever a client session begins a task as it, so the rows come from
// the task entries, not from the task board. A day is dozens of entries, so the
// menu gets the few rows it can hold and how many more there are, never the
// history, and no prompt or summary text. Each row names the console page it
// opens as a fuli:// link.

const WINDOW_MS = 24 * 60 * 60 * 1000;
const THREADS_READ = 30;
const ASSISTANT_ROWS = 5;
const ROUNDTABLE_ROWS = 3;
const SUBJECT_CHARS = 60;
const ALL_ASSISTANTS = 'fuli://project-agents';
const ALL_ROUNDTABLES = 'fuli://roundtables';

export async function desktopGlance({ app, now = Date.now }) {
  const personalSpaceId = app.config?.personal?.spaceId ?? null;
  if (!personalSpaceId) return { assistants: section([], [], ALL_ASSISTANTS), roundtables: section([], [], ALL_ROUNDTABLES) };
  const since = new Date(now() - WINDOW_MS).toISOString();
  const worked = await app.personal.recentWorkingAgents({ personalSpaceId, since });
  // At work now first; within each, the latest first as the Provider sent them.
  const ordered = [...worked.filter((agent) => agent.working), ...worked.filter((agent) => !agent.working)];
  const shown = ordered.slice(0, ASSISTANT_ROWS);
  const talking = (app.roundtable?.threads({ limit: THREADS_READ }).threads ?? [])
    .filter((thread) => thread.waiting && Date.parse(thread.updatedAt) >= Date.parse(since));
  return {
    assistants: section(await named(app, personalSpaceId, shown), ordered.slice(shown.length), ALL_ASSISTANTS),
    roundtables: section(talking.slice(0, ROUNDTABLE_ROWS).map((thread) => ({
      subject: singleLineExcerpt(thread.subject, SUBJECT_CHARS),
      replying: thread.replying,
      waitingFor: thread.waitingFor,
      link: `fuli://roundtables/${encodeURIComponent(thread.id)}`
    })), talking.slice(ROUNDTABLE_ROWS), ALL_ROUNDTABLES)
  };
}

// The rows the menu holds, how many were past them, and the page of them all.
const section = (rows, rest, link) => ({ rows, more: rest.length, link });

// Each row with its assistant's shown name; an assistant that cannot be read
// has no name to show and no page to open, so its row is left out.
async function named(app, personalSpaceId, agents) {
  const records = await Promise.allSettled(agents.map((agent) =>
    app.getProjectAgent({ personalSpaceId, personalProjectId: null, agentId: agent.agent_id })));
  return agents.flatMap((agent, index) => {
    const profile = records[index].status === 'fulfilled' ? records[index].value.profile : null;
    const name = profile?.displayName || profile?.name;
    return name ? [{ name, working: agent.working, at: agent.last_active,
      link: `fuli://agents/${encodeURIComponent(personalSpaceId)}/${encodeURIComponent(agent.agent_id)}` }] : [];
  });
}
