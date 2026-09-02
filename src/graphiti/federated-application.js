import { dirname } from 'node:path';
import { createEmployeeService } from '../employees/service.js';

import { GraphitiProviderClient } from './provider-client.js';
import {
  aggregatePublicCapabilities,
  createWorkspaceProvider
} from './workspace-provider-client.js';
import {
  canonicalProviderUrl,
  readGraphRuntimeConfig
} from './runtime-config.js';
import { ApplicationError, ApplicationErrorCode } from '../app/application-error.js';
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
import { mergeExternalKnowledgeProjection } from '../external-knowledge/graph-projection.js';
import { ProviderTaskContextRegistry } from '../mcp/provider-task-context-registry.js';
import { attachExternalKnowledgeRuntime } from '../external-knowledge/runtime.js';
import { resolveSetupPaths } from '../setup/paths.js';
import {
  beginTaskContext as beginTaskContextWorkflow,
  checkpointTaskKnowledge as checkpointTaskKnowledgeWorkflow,
  discoverCommonKnowledgeCandidates as discoverCommonKnowledgeCandidatesWorkflow,
  discoverPersonalGlobalPreferenceCandidates as
    discoverPersonalGlobalPreferenceCandidatesWorkflow,
  applyPersonalGlobalPreferenceDecision as
    applyPersonalGlobalPreferenceDecisionWorkflow,
  providerCommonKnowledgePromotion,
  recordDecisionTrace as recordDecisionTraceWorkflow,
  recordKnowledgeFeedback as recordKnowledgeFeedbackWorkflow,
  searchCurrentProjectKnowledge as searchCurrentProjectKnowledgeWorkflow,
  previewPersonalGlobalPreferenceDecision as
    previewPersonalGlobalPreferenceDecisionWorkflow
} from './agent-knowledge-workflows.js';
import {
  assertPublicKnowledgeEligible,
  providerConfirmationActor,
  providerConfirmationBasis,
  providerEpisode
} from './knowledge-provider-mapping.js';
import { providerProjectProfile } from './project-profile-mapping.js';
import {
  ProjectAgentControlPlaneApplication,
  projectAgentControlPlaneHooks
} from './project-agent-control-plane.js';
import {
  finishKnowledgeReview as finishKnowledgeReviewWorkflow,
  listKnowledgeReviewCandidates as listKnowledgeReviewCandidatesWorkflow,
  recordKnowledgeReviewProgress as recordKnowledgeReviewProgressWorkflow,
  startKnowledgeReview as startKnowledgeReviewWorkflow
} from './knowledge-review.js';
import {
  providerWorkflowCandidateSearch,
  workflowCandidatePage
} from './workflow-candidate-mapping.js';
import {
  providerWorkflowTransitionObservation
} from './workflow-observation.js';
import {
  relatedProjectGuidance
} from './related-project-suggestions.js';
import {
  getCollaborationPreferences as getCollaborationPreferencesWorkflow
} from './collaboration-preference-workflow.js';
import { buildUserTasteSkill } from './user-taste-skill.js';
import { resolveTaskEntryAgent, loadProjectAgentContinuity } from './project-agent-task-entry.js';
import { getWritingTasteProfile as getWritingTasteProfileWorkflow } from './writing-taste-profile-workflow.js';
import {
  groupSubscriptions,
  loadSearchRelatedProjectSuggestions,
  rankedSearchItems,
  retrievalGuidanceForScope
} from './federated-search-support.js';

export function openFederatedGraphApplication({
  runtimeConfigPath,
  config,
  capturePolicyStore,
  agentAccessPolicyStore,
  fetchImpl = globalThis.fetch,
  env = process.env
}) {
  const resolved = config ?? readGraphRuntimeConfig(runtimeConfigPath);
  const policyStore = capturePolicyStore ?? new CapturePolicyStore(
    capturePolicyPathForRuntime(runtimeConfigPath)
  );
  const app = new FederatedGraphApplication(resolved, {
    fetchImpl,
    capturePolicyStore: policyStore,
    agentAccessPolicyStore: agentAccessPolicyStore ?? new AgentAccessPolicyStore(
      agentAccessPolicyPathForRuntime(runtimeConfigPath)
    ),
    consoleUrl: sourceConsoleUrl(runtimeConfigPath),
    providerRequestTimeoutMs: providerRequestTimeoutFromEnv(env)
  });
  if (typeof runtimeConfigPath === 'string' && runtimeConfigPath) {
    attachExternalKnowledgeRuntime(app, {
      paths: resolveSetupPaths({ dataDir: dirname(runtimeConfigPath) }),
      env,
      fetchImpl
    });
    app.employees = createEmployeeService({ app, runtimeConfigPath });
  }
  return app;
}

function providerRequestTimeoutFromEnv(env) {
  const value = env?.FULI_PROVIDER_REQUEST_TIMEOUT_MS;
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 2_147_483_647) {
    throw new TypeError(
      'FULI_PROVIDER_REQUEST_TIMEOUT_MS must be a positive safe integer'
    );
  }
  return parsed;
}

export class FederatedGraphApplication extends ProjectAgentControlPlaneApplication {
  constructor(config, {
    fetchImpl = globalThis.fetch,
    capturePolicyStore = new CapturePolicyStore(),
    agentAccessPolicyStore = new AgentAccessPolicyStore(),
    consoleUrl = sourceConsoleUrl(null),
    projectPathResolver = resolvePersonalProjectPath,
    taskContextRegistry = null,
    providerRequestTimeoutMs = undefined
  } = {}) {
    super();
    this.graphiti = true;
    this.config = config;
    this.capturePolicyStore = capturePolicyStore;
    this.agentAccessPolicyStore = agentAccessPolicyStore;
    this.consoleUrl = consoleUrl;
    this.projectPathResolver = projectPathResolver;
    this.personal = new GraphitiProviderClient({
      baseUrl: config.personal.providerUrl,
      accessToken: config.personal.accessToken,
      workflowObservationToken: config.personal.workflowObservationToken ?? null,
      fetchImpl,
      requestTimeoutMs: providerRequestTimeoutMs
    });
    this.taskContextRegistry = taskContextRegistry ?? new ProviderTaskContextRegistry(
      this.personal, config.personal.spaceId
    );
    this.workspaces = new Map(config.workspaces.map((workspace) => {
      const provider = createWorkspaceProvider(workspace, {
        fetchImpl, requestTimeoutMs: providerRequestTimeoutMs
      });
      return [provider.providerUrl, provider];
    }));
  }

  async beginTaskContext(input) {
    return beginTaskContextWorkflow(this, input);
  }

  async checkpointTaskKnowledge(input) {
    return checkpointTaskKnowledgeWorkflow(this, input);
  }

  verifyTaskCheckpoint({ sessionId, sourceApplication = 'other' }) {
    return this.taskContextRegistry.verify(sessionId, sourceApplication);
  }

  async recordDecisionTrace(input) {
    this.#assertActivePersonalSpace(input.personalSpaceId);
    return recordDecisionTraceWorkflow(this, input);
  }

  validateCaptureSessionKnowledge(input) {
    if (this.getCapturePolicy().enabled) this.#prepareKnowledgeCapture(input);
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
    const { episode, workspace } = this.#prepareKnowledgeCapture(input);
    if (input.targetKind === 'personal') {
      const result = await this.personal.commit({
        space_id: input.spaceId,
        personal_project_id: input.personalProjectId ?? null,
        project_agent_id: input.projectAgentId ?? null,
        episode
      });
      return { route: 'personal', ...result };
    }
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

  async recordWorkflowTransitionObservation(input) {
    this.#assertActivePersonalSpace(input.personalSpaceId);
    const capturePolicy = this.getCapturePolicy();
    if (!capturePolicy.enabled) {
      return {
        route: 'disabled',
        status: 'capture_disabled',
        capturePolicy
      };
    }
    assertNoCredentials(input);
    const result = await this.personal.recordWorkflowObservation(
      providerWorkflowTransitionObservation(input)
    );
    return { route: 'personal', ...result };
  }

  async getCollaborationPreferences({
    personalProjectId = null,
    projectAgentId = null,
    projectPath = null,
    taskPrompt = null,
    sourceApplication = 'other',
    sourceSessionId = null,
    sessionId = null,
    turnId = null,
    workKind = null,
    requiredCapabilities = [],
    limit = 100,
    agentInvocation = false,
    agentToolName = 'get_collaboration_preferences'
  } = {}) {
    const projectResolution = await this.#resolvePreferenceProject({ personalProjectId, projectPath });
    const selection = projectPath === null && !personalProjectId && !projectAgentId
      ? null
      : await resolveTaskEntryAgent(
      this, projectResolution, { projectAgentId, taskPrompt, sourceApplication,
        sessionId: agentToolName === 'get_collaboration_preferences'
          ? sessionId ?? sourceSessionId : turnId ? sessionId : null,
        turnId: agentToolName === 'begin_task_context' ? turnId : null,
        workKind, requiredCapabilities, agentInvocation, agentToolName }
    );
    // A rejected explicit role must not leak its private preferences via fallback.
    const selectedAgentId = selection ? selection.agent?.agentId ?? null : projectAgentId;
    const preferences = await getCollaborationPreferencesWorkflow(
      this,
      projectResolution,
      {
        projectAgentId: selectedAgentId,
        taskPrompt,
        limit,
        agentInvocation,
        agentToolName
      },
      (items, toolName) => this.#recordAgentViews(items, toolName)
    );
    const management = this.employees && agentInvocation &&
      ['begin_task_context', 'get_collaboration_preferences'].includes(agentToolName)
      ? await this.employees.taskEntry({ personalProjectId: projectResolution.personalProjectId,
        sourceApplication, sourceSessionId, sessionId })
      : null;
    const managedPreferences = management ? { ...preferences, project_management_context: management } : preferences;
    if (!selection) return managedPreferences;
    const context = selection.agent ? await loadProjectAgentContinuity(this, {
      projectId: projectResolution.personalProjectId, agent: selection.agent,
      sourceApplication, taskPrompt, selectionReason: selection.reason,
      matchBasis: selection.match_basis
    }) : selection;
    return { ...managedPreferences, project_agent_context: context };
  }

  async getUserTasteSkill({
    personalProjectId = null,
    projectPath = null,
    taskPrompt = null,
    limit = 100
  } = {}) {
    const context = await this.getCollaborationPreferences({
      personalProjectId,
      projectPath,
      taskPrompt,
      limit,
      agentInvocation: true,
      agentToolName: 'get_user_taste_skill'
    });
    const skill = buildUserTasteSkill({
      preferences: context.effective_preferences,
      taskPrompt,
      personalSpaceId: context.context.personal_space_id,
      personalProjectId: context.context.personal_project_id
    });
    return {
      status: 'generated',
      ...skill,
      ...(context.task_knowledge_recall
        ? { task_knowledge_recall: context.task_knowledge_recall }
        : {}),
      application_guidance: context.application_guidance,
      deferred_conflicts: context.deferred_conflicts,
      context: context.context
    };
  }

  async getWritingTasteProfile(input = {}) {
    this.#assertActivePersonalSpace(input.personalSpaceId);
    return getWritingTasteProfileWorkflow(this, input);
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
    projectAgentId = null,
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
    if (projectAgentId && (!personalProjectId || personalProjectScope !== 'bounded')) {
      throw new TypeError(
        'Project Agent search requires one bounded active personal project'
      );
    }
    const subscriptions = projectIds.length
      ? await this.personal.listSubscriptions(personalSpaceId)
      : [];
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
      .map((personalProjectIds, index) => {
        const activePersonalProjectId = (
          personalProjectScope === 'bounded' &&
          personalProjectId &&
          personalProjectIds.includes(personalProjectId)
        ) ? personalProjectId : null;
        return this.personal.search({
        space_ids: [personalSpaceId],
        query,
        limit,
        include_historical: includeHistorical,
        include_exploratory: includePending,
        personal_project_ids: personalProjectIds,
        active_personal_project_id: activePersonalProjectId,
        project_agent_id: activePersonalProjectId ? projectAgentId : null,
        inherit_project_knowledge: personalProjectScope === 'bounded',
        include_personal_global: index === 0
        });
      });
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
    const relatedProjects = await loadSearchRelatedProjectSuggestions(
      this,
      { facts, entities }
    );
    return {
      query,
      sourceMarker,
      noMatchSourceMarker,
      retrievalGuidance: retrievalGuidanceForScope(personalProjectScope),
      facts,
      entities,
      personalGlobalIncluded: true,
      personalProjectScope,
      projectAgentId,
      searchedPersonalProjectIds: selectedPersonalProjectIds,
      requestedProjectIds,
      searchedProjectIds,
      failedProjectIds: unavailableProjectIds,
      partial: unavailableProjectIds.length > 0,
      subscriptions: selectedSubscriptions,
      relatedProjectSuggestions: relatedProjects.suggestions,
      relatedProjectSuggestionsStatus: relatedProjects.status,
      relatedProjectGuidance: relatedProjectGuidance(relatedProjects.suggestions)
    };
  }

  async searchCurrentProjectKnowledge(input) {
    const resolution = await this.#resolvePreferenceProject({
      personalProjectId: input.personalProjectId ?? null,
      projectPath: input.projectPath
    });
    return searchCurrentProjectKnowledgeWorkflow(this, resolution, input);
  }

  async discoverCommonKnowledgeCandidates(input) {
    this.#assertActivePersonalSpace(input.personalSpaceId);
    return discoverCommonKnowledgeCandidatesWorkflow(this, input);
  }

  async discoverPersonalGlobalPreferenceCandidates(input) {
    this.#assertActivePersonalSpace(input.personalSpaceId);
    return discoverPersonalGlobalPreferenceCandidatesWorkflow(this, input);
  }

  async previewPersonalGlobalPreferenceDecision(input) {
    this.#assertActivePersonalSpace(input.personalSpaceId);
    assertSafeKnowledgeMutation(input);
    return previewPersonalGlobalPreferenceDecisionWorkflow(this, input);
  }

  async applyPersonalGlobalPreferenceDecision(input) {
    this.#assertActivePersonalSpace(input.personalSpaceId);
    assertSafeKnowledgeMutation(input);
    return applyPersonalGlobalPreferenceDecisionWorkflow(this, input);
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
    offset = null,
    agentInvocation = false,
    agentToolName = 'get_knowledge_graph'
  }) {
    if (!providerUrl) {
      if (spaceId !== this.config.personal.spaceId) {
        throw new TypeError('A configured providerUrl is required for a team-shared project graph');
      }
      const result = await this.personal.graph(
        spaceId,
        limit,
        personalProjectId,
        offset
      );
      if (agentInvocation) {
        await this.#recordAgentViews([
          ...result.nodes.map(({ id }) => ({ item_id: id, item_kind: 'entity' })),
          ...result.edges.map(({ id }) => ({ item_id: id, item_kind: 'relationship' }))
        ], agentToolName);
      }
      return mergeExternalKnowledgeProjection(
        this.externalKnowledge, result, spaceId, personalProjectId
      );
    }
    if (personalProjectId) {
      throw new TypeError('Personal project scope cannot be used with a team-shared provider');
    }
    return this.#workspace(providerUrl).client.graph(spaceId, limit, null, offset);
  }

  async startKnowledgeReview(input) {
    return startKnowledgeReviewWorkflow(this, input);
  }

  async listKnowledgeReviewCandidates(input) {
    return listKnowledgeReviewCandidatesWorkflow(this, input);
  }

  async recordKnowledgeReviewProgress(input) {
    return recordKnowledgeReviewProgressWorkflow(this, input);
  }

  async finishKnowledgeReview(input) {
    return finishKnowledgeReviewWorkflow(this, input);
  }

  async listWorkflowCandidates(input) {
    this.#assertActivePersonalSpace(input.personalSpaceId);
    const result = await this.personal.searchWorkflowCandidates(
      providerWorkflowCandidateSearch(input)
    );
    return workflowCandidatePage(result);
  }

  async recommendNextWorkflowSteps(input) {
    this.#assertActivePersonalSpace(input.personalSpaceId);
    const result = await this.personal.recommendWorkflowCandidates(
      providerWorkflowCandidateSearch(input)
    );
    return workflowCandidatePage(result);
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
    const [availablePersonalSpaces, personalProjects, subscriptions, ...workspaceSpaces] = await Promise.all([
      this.personal.listSpaces(),
      this.personal.listPersonalProjects(this.config.personal.spaceId),
      this.personal.listSubscriptions(this.config.personal.spaceId),
      ...[...this.workspaces.values()].map(async (workspace) => ({
        providerUrl: workspace.providerUrl,
        principalId: workspace.principalId,
        spaces: await safely(() => workspace.client.listSpaces(), [])
      }))
    ]);
    const personalSpaces = availablePersonalSpaces.filter(({ id }) => id === this.config.personal.spaceId);
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
            protocol: workspace.protocol,
            capabilities: workspace.capabilities,
            ...(await workspace.client.health())
          };
        } catch {
          return {
            providerUrl: workspace.providerUrl,
            protocol: workspace.protocol,
            capabilities: workspace.capabilities,
            status: 'unavailable'
          };
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
      capabilities: aggregatePublicCapabilities(
        this.workspaces, providers.workspaces, spaces.projects
      )
    };
  }

  close() { return this.employees?.close(); }

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

  [projectAgentControlPlaneHooks.assertActivePersonalSpace](personalSpaceId) {
    this.#assertActivePersonalSpace(personalSpaceId);
  }

  async [projectAgentControlPlaneHooks.resolvePreferenceProject](input) {
    return this.#resolvePreferenceProject(input);
  }

  #prepareKnowledgeCapture(input) {
    assertNoCredentials(input);
    const episode = providerEpisode(input);
    if (input.targetKind === 'personal') {
      if (input.spaceId !== this.config.personal.spaceId) {
        throw new ApplicationError(
          ApplicationErrorCode.VALIDATION,
          'Personal capture target must be the active personal space'
        );
      }
      return { episode };
    }
    if (input.projectAgentId) {
      throw new ApplicationError(
        ApplicationErrorCode.VALIDATION,
        'Project Agent knowledge can only be captured in the personal graph'
      );
    }
    if (episode.sensitivity !== 'normal') {
      throw new ApplicationError(
        ApplicationErrorCode.VALIDATION,
        'Private or restricted knowledge cannot enter a team-shared project queue. Use targetKind "personal" with personalProjectId to keep it in the personal graph'
      );
    }
    assertPublicKnowledgeEligible(episode);
    return { episode, workspace: this.#workspace(input.providerUrl) };
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

async function safely(operation, fallback) {
  try {
    return await operation();
  } catch {
    return fallback;
  }
}
