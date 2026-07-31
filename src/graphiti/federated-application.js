import { GraphitiProviderClient } from './provider-client.js';
import {
  canonicalProviderUrl,
  readGraphRuntimeConfig
} from './runtime-config.js';
import { ApplicationError } from '../app/application-error.js';
import { detectSensitiveContent } from '../security/sensitive-content.js';
import {
  CapturePolicyStore,
  capturePolicyPathForRuntime
} from './capture-policy.js';
import {
  AgentAccessPolicyStore,
  agentAccessPolicyPathForRuntime
} from './agent-access-policy.js';
import {
  personalContextProjectIds,
  personalProjectSearchBatches,
  scopedSearchItems
} from './personal-context.js';
import {
  createFuliSourceMarker,
  sourceConsoleUrl
} from './source-marker.js';
import { resolvePersonalProjectPath } from './project-path-context.js';
import { TaskContextRegistry } from '../mcp/task-context-registry.js';
import {
  agentProjectResolution,
  beginTaskContext as beginTaskContextWorkflow,
  checkpointTaskKnowledge as checkpointTaskKnowledgeWorkflow,
  discoverCommonKnowledgeCandidates as discoverCommonKnowledgeCandidatesWorkflow,
  providerCommonKnowledgePromotion,
  recordDecisionTrace as recordDecisionTraceWorkflow,
  recordKnowledgeFeedback as recordKnowledgeFeedbackWorkflow,
  searchCurrentProjectKnowledge as searchCurrentProjectKnowledgeWorkflow
} from './agent-knowledge-workflows.js';
import {
  assertPublicKnowledgeEligible,
  providerConfirmationActor,
  providerConfirmationBasis,
  providerEpisode
} from './knowledge-provider-mapping.js';

export function openFederatedGraphApplication({
  runtimeConfigPath,
  config,
  capturePolicyStore,
  agentAccessPolicyStore,
  fetchImpl = globalThis.fetch
}) {
  const resolved = config ?? readGraphRuntimeConfig(runtimeConfigPath);
  const policyStore = capturePolicyStore ?? new CapturePolicyStore(
    capturePolicyPathForRuntime(runtimeConfigPath)
  );
  return new FederatedGraphApplication(resolved, {
    fetchImpl,
    capturePolicyStore: policyStore,
    agentAccessPolicyStore: agentAccessPolicyStore ?? new AgentAccessPolicyStore(
      agentAccessPolicyPathForRuntime(runtimeConfigPath)
    ),
    consoleUrl: sourceConsoleUrl(runtimeConfigPath)
  });
}

export class FederatedGraphApplication {
  constructor(config, {
    fetchImpl = globalThis.fetch,
    capturePolicyStore = new CapturePolicyStore(),
    agentAccessPolicyStore = new AgentAccessPolicyStore(),
    consoleUrl = sourceConsoleUrl(null),
    projectPathResolver = resolvePersonalProjectPath,
    taskContextRegistry = new TaskContextRegistry(),
    providerRequestTimeoutMs = undefined
  } = {}) {
    this.graphiti = true;
    this.config = config;
    this.capturePolicyStore = capturePolicyStore;
    this.agentAccessPolicyStore = agentAccessPolicyStore;
    this.consoleUrl = consoleUrl;
    this.projectPathResolver = projectPathResolver;
    this.taskContextRegistry = taskContextRegistry;
    this.personal = new GraphitiProviderClient({
      baseUrl: config.personal.providerUrl,
      accessToken: config.personal.accessToken,
      fetchImpl,
      requestTimeoutMs: providerRequestTimeoutMs
    });
    this.workspaces = new Map(
      config.workspaces.map((workspace) => {
        const url = canonicalProviderUrl(workspace.providerUrl);
        return [url, {
          ...workspace,
          client: new GraphitiProviderClient({
            baseUrl: url,
            accessToken: workspace.accessToken,
            fetchImpl,
            requestTimeoutMs: providerRequestTimeoutMs
          })
        }];
      })
    );
  }

  async beginTaskContext(input) {
    return beginTaskContextWorkflow(this, input);
  }

  async checkpointTaskKnowledge(input) {
    return checkpointTaskKnowledgeWorkflow(this, input);
  }

  verifyTaskCheckpoint({ sessionId }) {
    return this.taskContextRegistry.verify(sessionId);
  }

  async recordDecisionTrace(input) {
    this.#assertActivePersonalSpace(input.personalSpaceId);
    return recordDecisionTraceWorkflow(this, input);
  }

  async captureSessionKnowledge(input) {
    const capturePolicy = this.getCapturePolicy();
    if (!capturePolicy.enabled) {
      return {
        route: 'disabled',
        status: 'capture_disabled',
        capturePolicy
      };
    }
    assertNoCredentials(input);
    const episode = providerEpisode(input);
    if (input.targetKind === 'personal') {
      if (input.spaceId !== this.config.personal.spaceId) {
        throw new TypeError('Personal capture target must be the active personal space');
      }
      const result = await this.personal.commit({
        space_id: input.spaceId,
        personal_project_id: input.personalProjectId ?? null,
        episode
      });
      return { route: 'personal', ...result };
    }
    if (episode.sensitivity !== 'normal') {
      throw new TypeError('Private or restricted knowledge cannot enter a team-shared project queue');
    }
    assertPublicKnowledgeEligible(episode);
    const workspace = this.#workspace(input.providerUrl);
    const draft = await this.personal.createPublicationDraft({
      personal_space_id: this.config.personal.spaceId,
      target_project_id: input.spaceId,
      provider_url: workspace.providerUrl,
      episode
    });
    return {
      route: 'personal_review',
      status: draft.status,
      draftId: draft.id,
      projectId: input.spaceId,
      providerUrl: workspace.providerUrl
    };
  }

  async getCollaborationPreferences({
    personalProjectId = null,
    projectPath = null,
    limit = 100,
    agentInvocation = false,
    agentToolName = 'get_collaboration_preferences'
  } = {}) {
    const projectResolution = await this.#resolvePreferenceProject({
      personalProjectId,
      projectPath
    });
    const resolvedProjectId = projectResolution.personalProjectId;
    const [result, queuedConflicts] = await Promise.all([
      this.personal.collaborationPreferences(
        this.config.personal.spaceId,
        resolvedProjectId,
        limit
      ),
      this.personal.listPreferenceConflicts(
        this.config.personal.spaceId,
        'ai_pending',
        limit
      )
    ]);
    const deferredConflicts = deferredPreferenceConflicts(
      result,
      queuedConflicts
    );
    if (agentInvocation) {
      const items = [
        ...(result.global_preferences ?? []),
        ...(result.project_preferences ?? [])
      ];
      await this.#recordAgentViews(items.map(({ id, item_kind: itemKind }) => ({
        item_id: id,
        item_kind: itemKind
      })), agentToolName);
    }
    const applicationGuidance = {
      apply: 'effective_preferences',
      global_scope: 'Apply personal-global preferences in every user task.',
      project_scope: resolvedProjectId
        ? `Also apply preferences scoped to the matched personal project ${resolvedProjectId}.`
        : 'No exact personal project matched; do not apply project-scoped preferences.',
      conflicts: 'Do not apply entries listed in conflicts until the user resolves them.',
      deferred_conflicts: 'If the current task would use a deferred_conflict, call resolve_deferred_preference_conflict before applying either side. Ignore unrelated deferred conflicts. The resolution must preserve the AI audit marker.',
      authority: 'Human or authoritative-source confirmed preferences outrank agent-confirmed preferences. Agent-confirmed preferences are usable but lower priority and remain explicitly marked.',
      pending: 'Pending preferences are available only through on-demand knowledge search; invalid and unrelated-project preferences are excluded. Automatic preference injection never counts as usage evidence.'
    };
    if (!agentInvocation) {
      return {
        ...result,
        deferred_conflicts: deferredConflicts,
        application_guidance: applicationGuidance,
        project_resolution: agentProjectResolution(projectResolution)
      };
    }
    return {
      effective_preferences: (result.effective_preferences ?? [])
        .map(agentCollaborationPreference),
      deferred_conflicts: deferredConflicts.map(agentDeferredPreferenceConflict),
      application_guidance: applicationGuidance,
      context: {
        personal_space_id: result.personal_space_id,
        personal_project_id: result.personal_project_id,
        global_preference_count: (result.global_preferences ?? []).length,
        project_preference_count: (result.project_preferences ?? []).length,
        conflict_count: (result.conflicts ?? []).length,
        ai_deferred_conflict_count: deferredConflicts.length,
        overridden_global_count: (result.overridden_global_ids ?? []).length,
        source_truncated: result.truncated === true,
        project_resolution: agentProjectResolution(projectResolution)
      }
    };
  }

  async #resolvePreferenceProject({ personalProjectId, projectPath }) {
    if (projectPath !== undefined && projectPath !== null) {
      const projects = await this.personal.listPersonalProjects(
        this.config.personal.spaceId
      );
      const resolution = this.projectPathResolver(projectPath, projects);
      if (
        personalProjectId
        && resolution.personalProjectId
        && personalProjectId !== resolution.personalProjectId
      ) {
        throw new TypeError(
          'personalProjectId conflicts with the exact projectPath match'
        );
      }
      if (personalProjectId) {
        return {
          status: 'matched',
          basis: 'explicit_personal_project_id',
          personalProjectId
        };
      }
      return resolution;
    }
    if (personalProjectId) {
      return {
        status: 'matched',
        basis: 'explicit_personal_project_id',
        personalProjectId
      };
    }
    return {
      status: 'not_provided',
      basis: null,
      personalProjectId: null
    };
  }

  async searchKnowledge({
    personalSpaceId,
    query,
    projectIds = [],
    personalProjectId = null,
    contextPersonalProjectIds = [],
    personalProjectScope = 'bounded',
    limit = 12,
    includeHistorical = false,
    includePending = true,
    agentInvocation = false,
    agentToolName = 'search_knowledge_graph'
  }) {
    if (personalSpaceId !== this.config.personal.spaceId) {
      throw new TypeError('Search must use the active personal space');
    }
    if (!['bounded', 'all_local_confirmed'].includes(personalProjectScope)) {
      throw new TypeError('Unknown personal project search scope');
    }
    const subscriptions = await this.personal.listSubscriptions(personalSpaceId);
    const requestedProjects = new Set(projectIds);
    const selectedSubscriptions = subscriptions.filter(({ project_id: projectId }) =>
      requestedProjects.has(projectId)
    );
    if (selectedSubscriptions.length !== requestedProjects.size) {
      throw new TypeError('Every selected project must be an active subscription');
    }
    const selectedPersonalProjectIds = personalProjectScope === 'all_local_confirmed'
      ? personalContextProjectIds(
        null,
        (await this.personal.listPersonalProjects(personalSpaceId))
          .map(({ project_id: projectId }) => projectId)
      )
      : personalContextProjectIds(personalProjectId, contextPersonalProjectIds);
    const personalSearches = personalProjectSearchBatches(selectedPersonalProjectIds)
      .map((personalProjectIds, index) => this.personal.search({
        space_ids: [personalSpaceId],
        query,
        limit,
        include_historical: includeHistorical,
        include_exploratory: includePending,
        personal_project_ids: personalProjectIds,
        active_personal_project_id: (
          personalProjectScope === 'bounded' &&
          personalProjectId &&
          personalProjectIds.includes(personalProjectId)
        ) ? personalProjectId : null,
        inherit_project_knowledge: personalProjectScope === 'bounded',
        include_personal_global: index === 0
      }));
    const grouped = groupSubscriptions(selectedSubscriptions);
    const workspaceSearches = [...grouped.entries()].map(([providerUrl, items]) => {
      const projectIdsForProvider = items.map(({ project_id: projectId }) => projectId);
      return {
        projectIds: projectIdsForProvider,
        operation: (async () => {
          const workspace = this.#workspace(providerUrl);
          const result = await workspace.client.search({
            space_ids: projectIdsForProvider,
            query,
            limit,
            include_historical: includeHistorical,
            include_exploratory: includePending
          });
          return scopedSearchItems(result, 'project', workspace.providerUrl);
        })()
      };
    });
    const searchResults = await Promise.allSettled([
      ...personalSearches,
      ...workspaceSearches.map(({ operation }) => operation)
    ]);
    const personalSettlements = searchResults.slice(0, personalSearches.length);
    const personalFailure = personalSettlements.find(({ status }) => status === 'rejected');
    if (personalFailure) throw personalFailure.reason;
    const personalItems = personalSettlements
      .map(({ value }) => scopedSearchItems(
        value,
        'personal',
        null,
        this.config.personal.spaceId
      ));
    const successfulProjectIds = new Set();
    const failedProjectIds = new Set();
    const projects = [];
    searchResults.slice(personalSearches.length).forEach((settlement, index) => {
      const { projectIds: providerProjectIds } = workspaceSearches[index];
      if (settlement.status === 'fulfilled') {
        projects.push(settlement.value);
        providerProjectIds.forEach((projectId) => successfulProjectIds.add(projectId));
        return;
      }
      providerProjectIds.forEach((projectId) => failedProjectIds.add(projectId));
    });
    const requestedProjectIds = [...requestedProjects];
    const searchedProjectIds = requestedProjectIds.filter((projectId) =>
      successfulProjectIds.has(projectId)
    );
    const unavailableProjectIds = requestedProjectIds.filter((projectId) =>
      failedProjectIds.has(projectId)
    );
    const rankedSources = [...personalItems, ...projects];
    const facts = rankedSearchItems(rankedSources, 'facts', limit);
    const entities = rankedSearchItems(rankedSources, 'entities', limit);
    const sourceMarker = createFuliSourceMarker({
      consoleUrl: this.consoleUrl,
      facts,
      entities
    });
    const noMatchSourceMarker = createFuliSourceMarker({
      consoleUrl: this.consoleUrl,
      facts: [],
      entities: []
    });
    if (agentInvocation) {
      await this.#recordAgentViews([
        ...facts
          .filter(({ scope }) => scope === 'personal')
          .map(({ id }) => ({ item_id: id, item_kind: 'relationship' })),
        ...entities
          .filter(({ scope }) => scope === 'personal')
          .map(({ id }) => ({ item_id: id, item_kind: 'entity' }))
      ], agentToolName);
    }
    return {
      query,
      sourceMarker,
      noMatchSourceMarker,
      retrievalGuidance: retrievalGuidanceForScope(personalProjectScope),
      facts,
      entities,
      personalGlobalIncluded: true,
      personalProjectScope,
      searchedPersonalProjectIds: selectedPersonalProjectIds,
      requestedProjectIds,
      searchedProjectIds,
      failedProjectIds: unavailableProjectIds,
      partial: unavailableProjectIds.length > 0,
      subscriptions: selectedSubscriptions
    };
  }

  async searchCurrentProjectKnowledge(input) {
    const resolution = await this.#resolvePreferenceProject({
      personalProjectId: null,
      projectPath: input.projectPath
    });
    return searchCurrentProjectKnowledgeWorkflow(this, resolution, input);
  }

  async discoverCommonKnowledgeCandidates(input) {
    this.#assertActivePersonalSpace(input.personalSpaceId);
    return discoverCommonKnowledgeCandidatesWorkflow(this, input);
  }

  async previewCommonKnowledgePromotion(input) {
    this.#assertActivePersonalSpace(input.personalSpaceId);
    assertSafeKnowledgeMutation(input);
    return this.personal.previewCommonKnowledgePromotion(
      providerCommonKnowledgePromotion(input)
    );
  }

  async applyCommonKnowledgePromotion(input) {
    this.#assertActivePersonalSpace(input.personalSpaceId);
    assertSafeKnowledgeMutation(input);
    return this.personal.applyCommonKnowledgePromotion({
      ...providerCommonKnowledgePromotion(input),
      operation_actor: input.operationActor ?? 'agent'
    });
  }

  async getKnowledgeGraph({
    spaceId,
    providerUrl = null,
    personalProjectId = null,
    limit = 500,
    agentInvocation = false,
    agentToolName = 'get_knowledge_graph'
  }) {
    if (!providerUrl) {
      if (spaceId !== this.config.personal.spaceId) {
        throw new TypeError('A configured providerUrl is required for a team-shared project graph');
      }
      const result = await this.personal.graph(spaceId, limit, personalProjectId);
      if (agentInvocation) {
        await this.#recordAgentViews([
          ...result.nodes.map(({ id }) => ({ item_id: id, item_kind: 'entity' })),
          ...result.edges.map(({ id }) => ({ item_id: id, item_kind: 'relationship' }))
        ], agentToolName);
      }
      return result;
    }
    if (personalProjectId) {
      throw new TypeError('Personal project scope cannot be used with a team-shared provider');
    }
    return this.#workspace(providerUrl).client.graph(spaceId, limit);
  }

  async recordKnowledgeUsage({
    personalSpaceId,
    taskId,
    sessionId = null,
    toolName = null,
    items
  }) {
    this.#assertActivePersonalSpace(personalSpaceId);
    return this.personal.recordKnowledgeUsage({
      personal_space_id: personalSpaceId,
      task_id: taskId,
      session_id: sessionId,
      tool_name: toolName,
      items: items.map((item) => ({
        item_id: item.itemId,
        item_kind: item.itemKind,
        use_kind: item.useKind
      }))
    });
  }

  async recordKnowledgeFeedback(input) {
    this.#assertActivePersonalSpace(input.personalSpaceId);
    assertSafeKnowledgeMutation({
      items: input.items.map((item) => ({
        existenceReason: item.reason,
        quadrantReason: item.evidenceSummary
      }))
    });
    return recordKnowledgeFeedbackWorkflow(this, input);
  }

  async reviseKnowledgeItem(input) {
    this.#assertActivePersonalSpace(input.personalSpaceId);
    assertSafeKnowledgeMutation(input);
    const body = {
      personal_space_id: input.personalSpaceId,
      personal_project_id: input.personalProjectId ?? null,
      item_kind: input.itemKind,
      action: input.action,
      reason: input.reason,
      name: input.name ?? null,
      summary: input.summary ?? null,
      fact: input.fact ?? null,
      operation_actor: input.operationActor ?? 'agent'
    };
    if (input.currentQuadrant !== undefined) {
      body.current_quadrant = input.currentQuadrant;
    }
    if (input.originQuadrant !== undefined) {
      body.origin_quadrant = input.originQuadrant;
    }
    if (input.epistemicStatus !== undefined) {
      body.epistemic_status = input.epistemicStatus;
    }
    if (input.confirmationStatus !== undefined) {
      body.confirmation_status = input.confirmationStatus;
    }
    if (input.confirmationBasis !== undefined) {
      body.confirmation_basis = providerConfirmationBasis(input.confirmationBasis);
    }
    if (input.reasoningSummary !== undefined) {
      body.reasoning_summary = input.reasoningSummary;
    }
    if (input.profileAspect !== undefined) {
      body.profile_aspect = input.profileAspect;
    }
    if (input.inheritanceMode !== undefined) {
      body.inheritance_mode = input.inheritanceMode;
    }
    if (input.inheritedProjectIds !== undefined) {
      body.inherited_project_ids = input.inheritedProjectIds;
    }
    if (input.replacementItemId !== undefined) {
      body.replacement_item_id = input.replacementItemId;
    }
    if (input.replacementItemKind !== undefined) {
      body.replacement_item_kind = input.replacementItemKind;
    }
    return this.personal.reviseKnowledgeItem(input.itemId, body);
  }

  async listPreferenceConflicts({
    personalSpaceId,
    status = null,
    limit = 500
  }) {
    this.#assertActivePersonalSpace(personalSpaceId);
    return this.personal.listPreferenceConflicts(
      personalSpaceId,
      status,
      limit
    );
  }

  async deferPreferenceConflict(input) {
    this.#assertActivePersonalSpace(input.personalSpaceId);
    return this.personal.deferPreferenceConflict({
      personal_space_id: input.personalSpaceId,
      conflict_id: input.conflictId,
      preference_key: input.preferenceKey,
      preference_scope: input.preferenceScope,
      preference_project_id: input.preferenceProjectId ?? null,
      left_item_id: input.leftItemId,
      left_item_kind: input.leftItemKind,
      right_item_id: input.rightItemId,
      right_item_kind: input.rightItemKind,
      reason: input.reason,
      operation_actor: input.operationActor ?? 'human'
    });
  }

  async resolveDeferredPreferenceConflict(input) {
    this.#assertActivePersonalSpace(input.personalSpaceId);
    assertSafeKnowledgeMutation(input);
    return this.personal.resolvePreferenceConflict(input.conflictId, {
      personal_space_id: input.personalSpaceId,
      resolution: input.resolution,
      reason: input.reason,
      canonical_item_id: input.canonicalItemId ?? null,
      merged_instruction: input.mergedInstruction ?? null,
      split_item_id: input.splitItemId ?? null,
      split_project_id: input.splitProjectId ?? null,
      operation_actor: input.operationActor ?? 'agent'
    });
  }

  async completePreferenceConflict(input) {
    this.#assertActivePersonalSpace(input.personalSpaceId);
    return this.personal.completePreferenceConflict(input.conflictId, {
      personal_space_id: input.personalSpaceId,
      resolution: input.resolution,
      reason: input.reason,
      operation_actor: input.operationActor ?? 'human'
    });
  }

  async confirmKnowledgeBatch(input) {
    this.#assertActivePersonalSpace(input.personalSpaceId);
    assertSafeKnowledgeMutation(input);
    return this.personal.confirmKnowledgeBatch({
      personal_space_id: input.personalSpaceId,
      group_kind: input.groupKind,
      group_value: input.groupValue,
      reason: input.reason,
      confirmer: providerConfirmationActor(input.confirmer),
      operation_actor: input.operationActor ?? 'agent',
      items: input.items.map((item) => ({
        item_id: item.itemId,
        item_kind: item.itemKind,
        existence_reason: item.existenceReason,
        quadrant_reason: item.quadrantReason,
        proposed_by: providerConfirmationActor(item.proposedBy)
      }))
    });
  }

  async reassignKnowledgeItem(input) {
    this.#assertActivePersonalSpace(input.personalSpaceId);
    return this.personal.reassignKnowledgeItem(input.itemId, {
      personal_space_id: input.personalSpaceId,
      item_kind: input.itemKind,
      target_project_id: input.targetProjectId,
      reason: input.reason,
      operation_actor: input.operationActor ?? 'agent'
    });
  }

  async setPersonalPreferenceScope(input) {
    this.#assertActivePersonalSpace(input.personalSpaceId);
    assertSafeKnowledgeMutation(input);
    return this.personal.setPreferenceScope(input.itemId, {
      personal_space_id: input.personalSpaceId,
      item_kind: input.itemKind,
      scope: input.scope,
      project_id: input.scope === 'project' ? input.projectId : null,
      reason: input.reason,
      operation_actor: input.operationActor ?? 'agent'
    });
  }

  async previewKnowledgeProjectAction(input) {
    this.#assertActivePersonalSpace(input.personalSpaceId);
    return this.personal.previewKnowledgeProjectAction(input.itemId, {
      personal_space_id: input.personalSpaceId,
      item_kind: input.itemKind,
      mode: input.mode ?? 'existing',
      target_project_id: input.targetProjectId ?? null,
      new_project_id: input.newProjectId ?? null,
      new_project_name: input.newProjectName ?? null,
      new_project_purpose: input.newProjectPurpose ?? null,
      keep_source_relation: input.keepSourceRelation ?? true,
      relation_type: input.relationType ?? 'RELATED_TO',
      conflict_resolution: input.conflictResolution ?? 'defer',
      reason: input.reason ?? null
    });
  }

  async applyKnowledgeProjectAction(input) {
    this.#assertActivePersonalSpace(input.personalSpaceId);
    assertSafeKnowledgeMutation(input);
    return this.personal.applyKnowledgeProjectAction(input.itemId, {
      personal_space_id: input.personalSpaceId,
      item_kind: input.itemKind,
      mode: input.mode,
      target_project_id: input.targetProjectId ?? null,
      new_project_id: input.newProjectId ?? null,
      new_project_name: input.newProjectName ?? null,
      new_project_purpose: input.newProjectPurpose ?? null,
      keep_source_relation: input.keepSourceRelation ?? true,
      relation_type: input.relationType ?? 'RELATED_TO',
      conflict_resolution: input.conflictResolution ?? 'defer',
      reason: input.reason,
      operation_actor: input.operationActor ?? 'agent'
    });
  }

  async searchHumanChanges({
    personalSpaceId,
    query = '',
    status = 'all',
    limit = 50,
    agentInvocation = false,
    agentToolName = 'search_human_knowledge_changes'
  }) {
    this.#assertActivePersonalSpace(personalSpaceId);
    const result = await this.personal.searchHumanChanges({
      personal_space_id: personalSpaceId,
      query,
      status,
      limit
    });
    if (agentInvocation) {
      await this.#recordAgentViews(
        result.items.map(({ item_id: itemId, item_kind: itemKind }) => ({
          item_id: itemId,
          item_kind: itemKind
        })),
        agentToolName
      );
    }
    return result;
  }

  async reviewHumanChange(input) {
    this.#assertActivePersonalSpace(input.personalSpaceId);
    assertSafeKnowledgeMutation(input);
    return this.personal.reviewHumanChange(input.itemId, {
      personal_space_id: input.personalSpaceId,
      item_kind: input.itemKind,
      human_change_version: input.humanChangeVersion,
      conflict_check: input.conflictCheck,
      classification_check: input.classificationCheck,
      note: input.note
    });
  }

  async listKnowledgeSpaces() {
    const [personalSpaces, personalProjects, subscriptions, ...workspaceSpaces] = await Promise.all([
      this.personal.listSpaces(),
      this.personal.listPersonalProjects(this.config.personal.spaceId),
      this.personal.listSubscriptions(this.config.personal.spaceId),
      ...[...this.workspaces.values()].map(async (workspace) => ({
        providerUrl: workspace.providerUrl,
        principalId: workspace.principalId,
        spaces: await safely(() => workspace.client.listSpaces(), [])
      }))
    ]);
    return {
      activePersonalSpaceId: this.config.personal.spaceId,
      personalSpaces,
      personalProjects,
      projects: workspaceSpaces.flatMap(({ providerUrl, principalId, spaces }) =>
        spaces.map((space) => ({
          ...space,
          providerUrl,
          isOwner: space.owner_id === principalId
        }))
      ),
      subscriptions
    };
  }

  async subscribePublicProject(input) {
    if (input.personalSpaceId !== this.config.personal.spaceId) {
      throw new TypeError('Subscription must belong to the active personal space');
    }
    const workspace = this.#workspace(input.providerUrl);
    const accessible = await workspace.client.listSpaces();
    if (!accessible.some(({ id }) => id === input.projectId)) {
      throw new TypeError('Public project is not accessible with the configured identity');
    }
    return this.personal.subscribe({
      personal_space_id: input.personalSpaceId,
      project_id: input.projectId,
      provider_url: workspace.providerUrl,
      project_name: input.projectName
    });
  }

  async unsubscribePublicProject(input) {
    if (input.personalSpaceId !== this.config.personal.spaceId) {
      throw new TypeError('Subscription must belong to the active personal space');
    }
    const workspace = this.#workspace(input.providerUrl);
    return this.personal.unsubscribe(
      input.personalSpaceId,
      input.projectId,
      workspace.providerUrl
    );
  }

  async publishPersonalProject(input) {
    if (input.personalSpaceId !== this.config.personal.spaceId) {
      throw new TypeError('Published project must belong to the active personal space');
    }
    const localProjectId = String(input.localProjectId ?? '').trim();
    if (!localProjectId) throw new TypeError('Local project ID is required');
    const releaseVersion = String(input.releaseVersion ?? '').trim();
    const updateSummary = String(input.updateSummary ?? '').trim();
    if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/.test(releaseVersion)) {
      throw new TypeError('Release version must use letters, numbers, dots, underscores, or hyphens');
    }
    if (!updateSummary || updateSummary.length > 4096) {
      throw new TypeError('Release update summary is required and must be at most 4096 characters');
    }
    const localProject = await this.personal.getPersonalProject(
      input.personalSpaceId,
      localProjectId
    );
    const workspace = this.#workspace(input.providerUrl);
    const project = await workspace.client.createSpace({
      name: localProject.profile.name,
      kind: 'project',
      description: localProject.profile.purpose?.slice(0, 2000) ?? null,
      publication_key: localProject.publication_key,
      profile: providerProjectProfile(localProject.profile),
      release: {
        version: releaseVersion,
        summary: updateSummary
      }
    });
    const subscription = await this.personal.subscribe({
      personal_space_id: input.personalSpaceId,
      project_id: project.id,
      provider_url: workspace.providerUrl,
      project_name: project.name
    });
    return { project: { ...project, providerUrl: workspace.providerUrl }, subscription };
  }

  async listProjectReleases(input) {
    const workspace = this.#workspace(input.providerUrl);
    return {
      projectId: input.projectId,
      providerUrl: workspace.providerUrl,
      releases: await workspace.client.listProjectReleases(input.projectId)
    };
  }

  async deletePublicProject(input) {
    const workspace = this.#workspace(input.providerUrl);
    const result = await workspace.client.deleteProject(input.projectId);
    await this.personal.unsubscribe(
      this.config.personal.spaceId,
      input.projectId,
      workspace.providerUrl
    );
    return { ...result, providerUrl: workspace.providerUrl };
  }

  async upsertPersonalProject(input) {
    if (input.personalSpaceId !== this.config.personal.spaceId) {
      throw new TypeError('Personal project must belong to the active personal space');
    }
    return this.personal.upsertPersonalProject({
      personal_space_id: input.personalSpaceId,
      project_id: input.projectId,
      profile: providerProjectProfile(input.profile)
    });
  }

  async listPersonalProjects(input = {}) {
    const personalSpaceId = input.personalSpaceId ?? this.config.personal.spaceId;
    if (personalSpaceId !== this.config.personal.spaceId) {
      throw new TypeError('Personal projects must use the active personal space');
    }
    return this.personal.listPersonalProjects(personalSpaceId);
  }

  async createProjectRelation(input) {
    const workspace = this.#workspace(input.providerUrl);
    return workspace.client.createProjectRelation(input.sourceProjectId, {
      target_project_id: input.targetProjectId,
      relation_type: input.relationType,
      note: input.note ?? null
    });
  }

  async listProjectRelations(input) {
    const workspace = this.#workspace(input.providerUrl);
    return {
      projectId: input.projectId,
      providerUrl: workspace.providerUrl,
      relations: await workspace.client.listProjectRelations(input.projectId)
    };
  }

  async reviewProjectRelation(input) {
    const workspace = this.#workspace(input.providerUrl);
    return workspace.client.decideProjectRelation(
      input.targetProjectId,
      input.relationId,
      { decision: input.decision, note: input.note ?? null }
    );
  }

  async listPersonalReviewQueue(input = {}) {
    const personalSpaceId = input.personalSpaceId ?? this.config.personal.spaceId;
    if (personalSpaceId !== this.config.personal.spaceId) {
      throw new TypeError('Personal review must use the active personal space');
    }
    return {
      personalSpaceId,
      drafts: await this.personal.listPublicationDrafts(
        personalSpaceId,
        input.status ?? 'pending'
      )
    };
  }

  async reviewPersonalDraft(input) {
    const personalSpaceId = this.config.personal.spaceId;
    if (!['submit_public', 'keep_personal', 'ignore'].includes(input.decision)) {
      throw new TypeError('Unknown personal draft decision');
    }
    if (input.decision !== 'submit_public') {
      return this.personal.decidePublicationDraft(personalSpaceId, input.draftId, {
        decision: input.decision,
        shared_proposal_id: null
      });
    }
    const draft = await this.personal.getPublicationDraft(personalSpaceId, input.draftId);
    if (draft.status !== 'pending') throw new TypeError('Publication draft is not pending');
    if (draft.episode.sensitivity !== 'normal') {
      throw new TypeError('Private or restricted knowledge cannot be submitted publicly');
    }
    assertPublicKnowledgeEligible(draft.episode);
    const workspace = this.#workspace(draft.provider_url);
    const proposal = await workspace.client.createProposal(draft.target_project_id, {
      episode: draft.episode
    });
    return this.personal.decidePublicationDraft(personalSpaceId, input.draftId, {
      decision: 'submit_public',
      shared_proposal_id: proposal.id
    });
  }

  async listReviewQueue({ projectId, providerUrl, status = 'pending' }) {
    const workspace = this.#workspace(providerUrl);
    return {
      projectId,
      providerUrl: workspace.providerUrl,
      proposals: await workspace.client.listProposals(projectId, status)
    };
  }

  async reviewProposal({ projectId, providerUrl, proposalId, decision, note = null }) {
    const workspace = this.#workspace(providerUrl);
    return workspace.client.decideProposal(projectId, proposalId, { decision, note });
  }

  async getGraphitiStatus() {
    const [personal, ...workspaces] = await Promise.all([
      this.personal.health(),
      ...[...this.workspaces.values()].map(async (workspace) => {
        try {
          return {
            providerUrl: workspace.providerUrl,
            ...(await workspace.client.health())
          };
        } catch {
          return { providerUrl: workspace.providerUrl, status: 'unavailable' };
        }
      })
    ]);
    return { personal, workspaces };
  }

  getCapturePolicy() {
    return this.capturePolicyStore.read();
  }

  updateCapturePolicy(input) {
    return this.capturePolicyStore.update(input);
  }

  getAgentAccessPolicy() {
    return this.agentAccessPolicyStore.read();
  }

  updateAgentAccessPolicy(input) {
    return this.agentAccessPolicyStore.update(input);
  }

  async state() {
    const [spaces, providers] = await Promise.all([
      this.listKnowledgeSpaces(),
      this.getGraphitiStatus()
    ]);
    const configured = this.workspaces.size > 0;
    const connected = providers.workspaces.some(({ status }) => status === 'ready');
    const publicStatus = configured ? (connected ? 'ready' : 'unavailable') : 'not_connected';
    return {
      mode: configured ? (connected ? 'connected' : 'degraded') : 'personal_only',
      ...spaces,
      providers,
      capturePolicy: this.getCapturePolicy(),
      agentAccessPolicy: this.getAgentAccessPolicy(),
      publicProvider: { configured, status: publicStatus },
      capabilities: {
        browsePublicProjects: connected,
        publishProject: connected,
        submitKnowledge: connected,
        subscribeProject: connected,
        reviewProposals: connected && spaces.projects.some(({ role }) => role === 'maintainer')
      }
    };
  }

  close() {}

  async #recordAgentViews(items, toolName) {
    const unique = new Map(items.map((item) => [
      `${item.item_kind}:${item.item_id}`,
      item
    ]));
    const values = [...unique.values()];
    for (let index = 0; index < values.length; index += 200) {
      await this.personal.recordAgentViews({
        personal_space_id: this.config.personal.spaceId,
        tool_name: toolName,
        items: values.slice(index, index + 200)
      });
    }
  }

  #assertActivePersonalSpace(personalSpaceId) {
    if (personalSpaceId !== this.config.personal.spaceId) {
      throw new TypeError('Knowledge changes must use the active personal space');
    }
  }

  #workspace(providerUrl) {
    const requested = providerUrl
      ? canonicalProviderUrl(providerUrl)
      : (this.workspaces.size === 1 ? [...this.workspaces.keys()][0] : null);
    const workspace = requested ? this.workspaces.get(requested) : null;
    if (!workspace) throw new TypeError('Public project provider is not configured');
    return { ...workspace, providerUrl: requested };
  }
}

function agentCollaborationPreference(item) {
  const preference = {
    instruction: item.instruction ?? '',
    preference_key: item.preference_key ?? item.key ?? item.id,
    title: item.title ?? item.preference_key ?? item.key ?? item.id,
    profile_aspect: item.profile_aspect ?? null,
    preference_scope: item.preference_scope ?? 'global',
    confirmation_status: item.confirmation_status ?? 'confirmed'
  };
  if (item.preference_project_id) {
    preference.preference_project_id = item.preference_project_id;
  }
  return preference;
}

function deferredPreferenceConflicts(result, queuedConflicts) {
  const items = [
    ...(result.global_preferences ?? []),
    ...(result.project_preferences ?? [])
  ];
  const itemById = new Map(items.map((item) => [item.id, item]));
  const activeConflictPairs = new Set(
    (result.conflicts ?? []).flatMap((conflict) => {
      const ids = conflict.item_ids ?? [];
      const pairs = [];
      for (let left = 0; left < ids.length; left += 1) {
        for (let right = left + 1; right < ids.length; right += 1) {
          pairs.push(preferenceConflictPairKey(ids[left], ids[right]));
        }
      }
      return pairs;
    })
  );
  return (queuedConflicts ?? [])
    .filter((conflict) =>
      conflict.status === 'ai_pending' &&
      activeConflictPairs.has(preferenceConflictPairKey(
        conflict.left_item_id,
        conflict.right_item_id
      )) &&
      itemById.has(conflict.left_item_id) &&
      itemById.has(conflict.right_item_id)
    )
    .map((conflict) => ({
      ...conflict,
      left: itemById.get(conflict.left_item_id),
      right: itemById.get(conflict.right_item_id)
    }));
}

function agentDeferredPreferenceConflict(conflict) {
  return {
    id: conflict.id,
    preference_key: conflict.preference_key,
    preference_scope: conflict.preference_scope,
    ...(conflict.preference_project_id
      ? { preference_project_id: conflict.preference_project_id }
      : {}),
    status: conflict.status,
    deferred_at: conflict.deferred_at,
    reason: conflict.reason,
    left: agentConflictPreference(conflict.left),
    right: agentConflictPreference(conflict.right),
    required_action: 'Resolve this conflict before using either side when it is relevant to the current task.',
    resolution_options: ['merge', 'keep_left', 'keep_right', 'split_scope']
  };
}

function agentConflictPreference(item) {
  return {
    item_id: item.id,
    item_kind: item.item_kind,
    title: item.title,
    instruction: item.instruction,
    confirmed_at: item.confirmed_at,
    attributes: item.attributes ?? {}
  };
}

function preferenceConflictPairKey(leftId, rightId) {
  return [leftId, rightId].sort().join('\u0000');
}

function assertNoCredentials(input) {
  const content = JSON.stringify({
    name: input.name,
    sourceDescription: input.sourceDescription,
    sourceUri: input.sourceUri,
    sourceExcerpt: input.sourceExcerpt,
    summary: input.summary,
    entities: input.entities,
    relationships: input.relationships
  });
  if (detectSensitiveContent(content).restricted) {
    throw new ApplicationError(
      'validation',
      'Structured knowledge contains credentials and cannot be stored'
    );
  }
}

function retrievalGuidanceForScope(personalProjectScope) {
  if (personalProjectScope === 'all_local_confirmed') {
    return {
      currentPersonalProjectScope: 'all_local_confirmed',
      markerToUseIfNoSupportingEvidence: 'noMatchSourceMarker',
      requiredNextActionIfNoSupportingEvidence:
        'search_current_workspace_files_or_ask_for_safe_root',
      workspaceFileSearch: {
        available: true,
        consentSource: 'bounded_expansion_confirmation',
        rootBoundary: 'current_working_directory',
        requiresSafeProjectOrWorkspaceRoot: true,
        forbiddenBroadRoots: ['user_home', 'filesystem_root'],
        readOnly: true,
        includesPublicProjects: false
      },
      instruction: 'Use read-only local file search in the current repository or explicit ' +
        'workspace root, preserving exact names first. If the working directory is the user ' +
        'home, filesystem root, or otherwise too broad, ask for a safe root. Never search ' +
        'outside that root or inspect credential stores; if no evidence supports the answer, ' +
        'ask for a source clue.'
    };
  }
  return {
    currentPersonalProjectScope: 'bounded',
    markerToUseIfNoSupportingEvidence: 'noMatchSourceMarker',
    requiredNextActionIfNoSupportingEvidence:
      'ask_user_to_confirm_all_local_and_workspace_search',
    expansion: {
      available: true,
      requiresExplicitUserConfirmation: true,
      input: { personalProjectScope: 'all_local_confirmed' },
      readOnly: true,
      oneQueryOnly: true,
      includesPublicProjects: false,
      includesCurrentWorkspaceFiles: true
    },
    instruction: 'Ask whether to widen this one read-only lookup to all registered local ' +
      'personal projects and, if still unresolved, current repository or workspace files. ' +
      'Exclude public projects and paths outside the current workspace; then stop and wait.'
  };
}

function assertSafeKnowledgeMutation(input) {
  const content = JSON.stringify({
    reason: input.reason,
    name: input.name,
    summary: input.summary,
    fact: input.fact,
    note: input.note,
    newProjectName: input.newProjectName,
    newProjectPurpose: input.newProjectPurpose,
    humanConfirmationReason: input.humanConfirmationReason,
    batchItems: input.items?.map((item) => ({
      existenceReason: item.existenceReason,
      quadrantReason: item.quadrantReason
    }))
  });
  if (detectSensitiveContent(content).restricted) {
    throw new ApplicationError(
      'validation',
      'Knowledge revision contains credentials and cannot be stored'
    );
  }
}

function providerProjectProfile(profile) {
  if (!profile || typeof profile !== 'object') throw new TypeError('Project profile is required');
  const assessment = profile.assessment ? sanitizeProjectAssessment(profile.assessment) : null;
  return {
    name: profile.name,
    purpose: profile.purpose ?? null,
    scope: profile.scope ?? null,
    technical_summary: profile.technical_summary ?? profile.technicalSummary ?? null,
    lifecycle: profile.lifecycle ?? 'planned',
    sources: profile.sources ?? [],
    boundaries: profile.boundaries ?? [],
    assessment
  };
}

function sanitizeProjectAssessment(input) {
  const assessment = {
    score: input.score,
    label: input.label,
    confirmed: input.confirmed ?? [],
    inferred: input.inferred ?? [],
    dimensions: (input.dimensions ?? []).map((dimension) => ({
      key: dimension.key,
      label: dimension.label,
      score: dimension.score,
      state: dimension.state === 'missing' ? 'inferred' : dimension.state,
      evidence: dimension.evidence ?? []
    })),
    analyzed_at: input.analyzed_at ?? input.analyzedAt
  };
  return assessment;
}

function groupSubscriptions(subscriptions) {
  const grouped = new Map();
  for (const subscription of subscriptions) {
    const url = canonicalProviderUrl(subscription.provider_url);
    if (!grouped.has(url)) grouped.set(url, []);
    grouped.get(url).push(subscription);
  }
  return grouped;
}

function rankedSearchItems(searchResults, key, limit) {
  return searchResults
    .flatMap((result) => result[key])
    .map((item, index) => ({ item, index }))
    .sort((left, right) =>
      searchItemScore(right.item) - searchItemScore(left.item) ||
      left.index - right.index
    )
    .slice(0, limit)
    .map(({ item }) => item);
}

function searchItemScore(item) {
  return typeof item?.score === 'number' && Number.isFinite(item.score)
    ? item.score
    : 0;
}

async function safely(operation, fallback) {
  try {
    return await operation();
  } catch {
    return fallback;
  }
}
