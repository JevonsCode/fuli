import { safeExternalSourceDiagnostic } from './safe-diagnostic.js';

export class ConnectedKnowledgeSearch {
  constructor({ app, externalKnowledge, policies }) {
    if (!app || !externalKnowledge || !policies) {
      throw new TypeError('Connected knowledge search requires app, externalKnowledge, and policies');
    }
    this.app = app;
    this.externalKnowledge = externalKnowledge;
    this.policies = policies;
  }

  async query(input) {
    const personalSpaceId = requiredString(input?.personalSpaceId, 'personalSpaceId');
    const personalProjectId = requiredString(input?.personalProjectId, 'personalProjectId');
    const query = requiredString(input?.query, 'query');
    const limit = positiveInteger(input?.limit ?? 12, 'limit', 100);
    const projectIds = stringArray(input?.projectIds, 'projectIds', 32);
    const contextPersonalProjectIds = stringArray(
      input?.contextPersonalProjectIds,
      'contextPersonalProjectIds',
      15
    );
    const [graph, bindings] = await Promise.all([
      this.app.searchKnowledge({
        personalSpaceId,
        personalProjectId,
        projectIds,
        contextPersonalProjectIds,
        personalProjectScope: input.personalProjectScope ?? 'bounded',
        query,
        limit,
        includeHistorical: input.includeHistorical === true,
        includePending: input.includePending !== false,
        agentInvocation: true,
        agentToolName: 'search_connected_knowledge'
      }),
      this.externalKnowledge.listBindings()
    ]);
    const selected = bindings.flatMap((binding) =>
      binding.status === 'ready'
        ? bindingTargets(binding)
            .filter((target) =>
              target.status !== 'error' &&
              target.mode !== 'mirror' &&
              target.personalSpaceId === personalSpaceId &&
              target.personalProjectId === personalProjectId
            )
            .map((target) => ({ binding, target }))
        : []
    );
    const retrieved = await Promise.allSettled(selected.map(({ binding, target }) =>
      this.externalKnowledge.retrieveBinding(binding.id, {
        query,
        limit,
        personalSpaceId: target.personalSpaceId,
        personalProjectId: target.personalProjectId
      })
    ));
    const external = [];
    const sourceErrors = [];
    for (const [index, outcome] of retrieved.entries()) {
      const { binding, target } = selected[index];
      const identity = {
        id: binding.id,
        name: binding.name,
        connectorType: binding.connectorType,
        targetId: target.id,
        mode: target.mode
      };
      if (outcome.status === 'fulfilled') {
        external.push({
          binding: identity,
          items: outcome.value.items ?? [],
          skippedCredentials: outcome.value.skippedCredentials ?? 0
        });
      } else {
        sourceErrors.push({
          binding: identity,
          error: safeExternalSourceDiagnostic(outcome.reason)
        });
      }
    }
    const conflictPolicy = this.policies.get(personalProjectId);
    return {
      query,
      graph,
      external,
      sourceErrors,
      sourceScopes: {
        personalProjectId,
        publicProjectIds: projectIds,
        publicSpaceStatus: projectIds.length ? 'beta' : 'not_requested'
      },
      conflictPolicy,
      conflictAssessmentRequired: requiresConflictAssessment({
        graph,
        external,
        publicProjectIds: projectIds
      }),
      conflictGuidance: guidanceFor(conflictPolicy.mode)
    };
  }

  getConflictPolicy({ personalProjectId }) {
    return this.policies.get(personalProjectId);
  }

  async updateConflictPolicy({ personalSpaceId, personalProjectId, mode }) {
    const projects = await this.app.listPersonalProjects({ personalSpaceId });
    if (!projects.some(({ project_id: id, id: fallback }) =>
      (id ?? fallback) === personalProjectId
    )) {
      throw new TypeError('Conflict policy target must be an existing personal project');
    }
    return this.policies.set(personalProjectId, mode);
  }
}

function bindingTargets(binding) {
  if (Array.isArray(binding.targets)) return binding.targets;
  return binding.target ? [{
    id: binding.id,
    ...binding.target,
    mode: binding.mode,
    status: binding.status
  }] : [];
}

function guidanceFor(mode) {
  return mode === 'agent_decide'
    ? 'When sources materially conflict, the Agent may decide for this response only. Explain the basis and source provenance; never rewrite, confirm, or invalidate underlying knowledge automatically.'
    : 'When sources materially conflict, surface the conflict in the Agent conversation and ask the user before selecting durable truth. Do not rewrite any source.';
}

function hasGraphEvidence(graph) {
  return (graph?.facts?.length ?? 0) > 0 || (graph?.entities?.length ?? 0) > 0;
}

function requiresConflictAssessment({ graph, external, publicProjectIds }) {
  const graphHasEvidence = hasGraphEvidence(graph);
  const liveSourceCount = external.filter(({ items }) => items.length > 0).length;
  return (graphHasEvidence ? 1 : 0) + liveSourceCount > 1 ||
    (graphHasEvidence && publicProjectIds.length > 0);
}

function stringArray(value, label, maximum) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maximum ||
      value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new TypeError(`${label} must be an array of at most ${maximum} nonempty strings`);
  }
  return [...new Set(value.map((item) => item.trim()))];
}

function positiveInteger(value, label, maximum) {
  if (!Number.isInteger(value) || value <= 0 || value > maximum) {
    throw new TypeError(`${label} must be a positive integer no greater than ${maximum}`);
  }
  return value;
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} is required`);
  return value.trim();
}
