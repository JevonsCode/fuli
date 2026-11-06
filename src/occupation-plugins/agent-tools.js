import { ApplicationError, InvalidInputError } from '../app/application-error.js';
import { projectExperiences } from '../graphiti/agent-growth.js';
import { requiredString } from '../validation/values.js';
import { projectAcceptanceChecks } from '../acceptance-checks/port.js';

// read_occupation_kit: an FLA reads its occupation's starter kit when it starts
// work of that kind, never on every turn (nothing of it is in the task entry).
// With a project it also gets what that project learned on top of the kit.
const ID_MAX_CHARS = 128;
// rec#78 rule 6: a few proven lessons on demand, not the whole history.
const MAX_LESSONS = 3;
const MAX_CHECKS = 10;

export const OCCUPATION_KIT_HANDLERS = Object.freeze({
  read_occupation_kit: async (app, input) => {
    const personalSpaceId = requiredString(input.personalSpaceId, 'personalSpaceId', ID_MAX_CHARS);
    const agentId = input.agentId == null ? null : requiredString(input.agentId, 'agentId', ID_MAX_CHARS);
    const personalProjectId = input.personalProjectId == null ? null
      : requiredString(input.personalProjectId, 'personalProjectId', ID_MAX_CHARS);
    const agents = agentId || personalProjectId ? await app.listProjectAgents({ personalSpaceId }) : [];
    const occupation = input.occupation ?? occupationOf(agents, agentId);
    const kit = plugins(app).kit({ personalSpaceId, agentId, occupation: requiredString(occupation, 'occupation', ID_MAX_CHARS) });
    if (!personalProjectId || !kit.plugin) return kit;
    return { ...kit, learned: await learnedOnTop(app, { personalSpaceId, personalProjectId, occupation, agents }) };
  }
});

function occupationOf(agents, agentId) {
  if (!agentId) throw new InvalidInputError('occupation is required when no agentId is given');
  const agent = agents.find(candidate => candidate.agentId === agentId);
  if (!agent) throw new InvalidInputError('agentId is not an Agent of this personal space');
  if (!agent.occupation?.role) throw new InvalidInputError('agentId has no occupation yet; pass occupation');
  return agent.occupation.role;
}

// The self-growth layer (rec#78): experiences the person kept in this project,
// reported by FLAs that hold this occupation. The upstream kit stays as it is;
// lessons and acceptance checks learned in use sit beside it.
async function learnedOnTop(app, { personalSpaceId, personalProjectId, occupation, agents }) {
  const holders = new Set(agents.filter(agent => agent.occupation?.role === occupation).map(agent => agent.agentId));
  const { items, partial } = await projectExperiences(app, personalSpaceId, personalProjectId,
    node => node.confirmation_status === 'confirmed' && holders.has(node.confirmation_basis?.proposed_by?.label));
  items.sort((a, b) => b.tasks - a.tasks || b.uses - a.uses);
  return {
    personalProjectId, partial, total: items.length,
    lessons: items.slice(0, MAX_LESSONS).map(item => ({ itemId: item.itemId, title: item.title, solution: item.solution,
      boundary: item.boundary, tasks: item.tasks })),
    // One reader of learned checks: the project's acceptance list, filtered to this occupation.
    checks: (await projectAcceptanceChecks(app, { personalSpaceId, personalProjectId, occupation, limit: MAX_CHECKS })).checks
      .map(check => ({ itemId: check.checkId, check: { kind: check.kind, text: check.text } }))
  };
}

function plugins(app) {
  if (!app.occupationPlugins) {
    throw new ApplicationError('occupation_plugins_unavailable', 'Occupation kits need a local FULI installation', { status: 503 });
  }
  return app.occupationPlugins;
}
