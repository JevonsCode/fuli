import { searchFederatedKnowledge } from './federated-search.js';
import {
  searchCurrentProjectKnowledge as searchCurrentProjectKnowledgeWorkflow
} from './current-project-knowledge-search.js';
import { mergeExternalKnowledgeProjection } from '../external-knowledge/graph-projection.js';
import { configuredWorkspace } from './workspace-provider-client.js';
import { recordAgentViews } from './agent-view-records.js';
import { resolvePreferenceProject } from './preference-project-resolution.js';
import { preferenceCondition } from '../conversations/preference-stated-case.js';
import { preferenceAlwaysInline } from './preference-task-scope.js';

export function searchKnowledge(application, input) {
  return searchFederatedKnowledge(application, input, {
    workspaceFor: providerUrl => configuredWorkspace(application.workspaces, providerUrl),
    recordAgentViews: (items, toolName) => recordAgentViews(application, items, toolName, {
      sourceApplication: input.sourceApplication, personalProjectId: input.personalProjectId ?? null,
      sessionId: input.sourceSessionId ?? null })
  });
}

export async function searchCurrentProjectKnowledge(application, input) {
  const resolution = await resolvePreferenceProject(application, {
    personalProjectId: input.personalProjectId ?? null,
    projectPath: input.projectPath
  });
  return searchCurrentProjectKnowledgeWorkflow(application, resolution, input);
}

// The console's read marks each preference that states when it applies with
// that case (`stated_case`) and each hard rule (`hard_rule`), both read as an
// entry reads them (preference-stated-case.js, preference-task-scope.js:
// outer, nested and attribute qualifiers alike), so the 偏好 page can count
// the habits that state none. Read-only, derived from what the read returned.
function withStatedCases(graph) {
  const cased = (item, instruction) => {
    if (!item.profile_aspect) return item;
    const preference = { instruction, attributes: item.attributes, preference_qualifiers: item.preference_qualifiers };
    const condition = preferenceCondition(preference);
    return { ...item, ...(condition ? { stated_case: condition.text } : {}),
      ...(preferenceAlwaysInline(preference) ? { hard_rule: true } : {}) };
  };
  return { ...graph, nodes: graph.nodes.map(node => cased(node, node.summary || node.name)),
    edges: graph.edges.map(edge => cased(edge, edge.fact)) };
}

// An Agent reads as its FLA (projectAgentId) or a plain session: no other FLA's knowledge. Only the
// console passes ownerReads (src/knowledge-owner-reads) for the person's full read; an MCP call cannot.
export async function getKnowledgeGraph(application, {
  spaceId,
  providerUrl = null,
  personalProjectId = null,
  projectAgentId = null,
  limit = 500,
  offset = null,
  agentInvocation = false,
  agentToolName = 'get_knowledge_graph',
  sourceApplication = null
}, ownerReads = null) {
  if (!providerUrl) {
    if (spaceId !== application.config.personal.spaceId) {
      throw new TypeError('A configured providerUrl is required for a team-shared project graph');
    }
    const result = ownerReads
      ? await ownerReads.graph({ spaceId, limit, personalProjectId, offset })
      : await application.personal.graph(spaceId, limit, personalProjectId, offset,
        projectAgentId ? { personalProjectId, projectAgentId } : null);
    if (agentInvocation) {
      await recordAgentViews(application, [
        ...result.nodes.map(({ id }) => ({ item_id: id, item_kind: 'entity' })),
        ...result.edges.map(({ id }) => ({ item_id: id, item_kind: 'relationship' }))
      ], agentToolName, { sourceApplication, personalProjectId });
    }
    return mergeExternalKnowledgeProjection(
      application.externalKnowledge, ownerReads ? withStatedCases(result) : result, spaceId, personalProjectId
    );
  }
  if (personalProjectId) {
    throw new TypeError('Personal project scope cannot be used with a team-shared provider');
  }
  return configuredWorkspace(application.workspaces, providerUrl).client.graph(spaceId, limit, null, offset);
}
