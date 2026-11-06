// Whether a project has stored anything a knowledge search could return
// (rec#88): a project whose graph holds only its own profile has nothing for a
// follow-up search to find, so the entry need not send the Agent looking.
// What the profile is: the project record, its brief fields and sources, and
// preferences, which reach a task only as effective_preferences.
export const PROFILE_NODE_TYPES = new Set(['PersonalProject', 'ProjectSource', 'PersonalPreference',
  'ProjectPurpose', 'ProjectScope', 'TechnicalSummary', 'ProjectBoundary']);
// Relations whose other project's knowledge the project's search inherits.
const INHERITING = new Set(['PART_OF', 'USES_KNOWLEDGE_FROM']);
// A bounded read: the profile alone is a handful of nodes; anything cut off counts as stored.
const PRESENCE_READ_LIMIT = 50;

// True only when the project's graph was read whole and holds nothing but
// its profile, with no project to inherit from. Any doubt (a failed or cut-off
// read, an inherited project, an item of any other type, current or pending)
// reads as stored, so the caller keeps its usual behaviour.
export async function projectStoresNothing(application, personalProjectId) {
  if (!personalProjectId || typeof application.personal?.graph !== 'function') return false;
  try {
    const graph = await application.personal.graph(application.config.personal.spaceId, PRESENCE_READ_LIMIT, personalProjectId);
    if (!graph || graph.truncated || !Array.isArray(graph.nodes)) return false;
    if ((graph.edges ?? []).some(edge => INHERITING.has(edge.type))) return false;
    return !graph.nodes.some(node => !PROFILE_NODE_TYPES.has(node.type) && !node.invalid_at);
  } catch {
    return false;
  }
}
