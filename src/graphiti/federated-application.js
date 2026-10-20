import { dirname, join } from 'node:path';
import { createEmployeeService } from '../employees/service.js';
import { createAgentRoundtable } from '../../packages/roundtable/src/roundtable/service.js';
import { createRoundtableStore } from '../../packages/roundtable/src/roundtable/store.js';
import { createPeerPort } from '../../packages/roundtable/src/peer/peer-port.js';
import { createFuliRoundtableHost } from './roundtable-host.js';
import { createJudgmentService } from '../judgment/service.js';
import { JudgmentStore } from '../judgment/store.js';
import { createJudgmentEngine } from '../judgment/engine.js';
import { createTaskScheduleService } from '../task-schedules/service.js';
import { openModelBackendRuntime } from '../model-backends/runtime.js';
import { TaskScheduleStore } from '../task-schedules/store.js';
import { createAgentDirectorySnapshots } from '../agents/directory-snapshots.js';
import { withTaskMemorySnapshot } from './project-agent-memory.js';
import { searchFederatedKnowledge } from './federated-search.js';
import { preflightTaskCaptures } from './task-knowledge-routing.js';

import { GraphitiProviderClient } from './provider-client.js';
import {
  aggregatePublicCapabilities,
  createWorkspaceProvider
} from './workspace-provider-client.js';
import {
  canonicalProviderUrl, personalTokenRefresher,
  readGraphRuntimeConfig
} from './runtime-config.js';
import { ApplicationError, ApplicationErrorCode } from '../app/application-error.js';
import { detectSensitiveContent } from '../security/sensitive-content.js';
import {
  CapturePolicyStore,
  capturePolicyPathForRuntime
} from './capture-policy.js';
import { captureDecision, captureDisabled } from './capture-decision.js';
import {
  AgentAccessPolicyStore,
  agentAccessPolicyPathForRuntime
} from './agent-access-policy.js';
import { RecallPolicyStore, recallPolicyPathForRuntime } from './recall-policy.js';
import {
  sourceConsoleUrl
} from './source-marker.js';
import { resolvePersonalProjectPath } from './project-path-context.js';
import { mergeExternalKnowledgeProjection } from '../external-knowledge/graph-projection.js';
import { ProviderTaskContextRegistry } from '../mcp/provider-task-context-registry.js';
import { readTaskPreferences } from './task-preference-reader.js';
import { attachExternalKnowledgeRuntime } from '../external-knowledge/runtime.js';
import { resolveSetupPaths } from '../setup/paths.js';
import { createNeedsPersonNotifier } from '../notifications/needs-person.js';
import { readRuntimeSettings } from '../system/runtime-settings.js';
import { describeSettings } from '../system/settings-guide.js';
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
  providerEpisode,
  providerPersonalCommit
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
import { buildUserTasteSkill } from './user-taste-skill.js';
import { taskEntryPreferences, finishTaskEntryPreferences } from './task-entry-preferences.js';
import { TASK_ENTRY_TOOLS, registerRepositoryProject } from './repository-project-registration.js';
import { resolveTaskEntryProject } from './task-entry-project-scope.js';
import { createSessionPreferenceDelivery } from '../conversations/preference-session.js';
import { getWritingTasteProfile as getWritingTasteProfileWorkflow } from './writing-taste-profile-workflow.js';
import { knowledgeTags } from './knowledge-tags.js';

export function openFederatedGraphApplication({
  runtimeConfigPath,
  config,
  capturePolicyStore,
  agentAccessPolicyStore,
  recallPolicyStore,
  tokenUsageResolver,
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
    recallPolicyStore: recallPolicyStore ?? new RecallPolicyStore(recallPolicyPathForRuntime(runtimeConfigPath)),
    tokenUsageResolver,
    consoleUrl: sourceConsoleUrl(runtimeConfigPath),
    providerRequestTimeoutMs: providerRequestTimeoutFromEnv(env),
    refreshPersonalToken: personalTokenRefresher(runtimeConfigPath, resolved.personal)
  });
  if (typeof runtimeConfigPath === 'string' && runtimeConfigPath) {
    app.preferenceDelivery = createSessionPreferenceDelivery({
      directory: join(dirname(runtimeConfigPath), 'preference-delivery'), env });
    const paths = resolveSetupPaths({ dataDir: dirname(runtimeConfigPath) });
    attachExternalKnowledgeRuntime(app, {
      paths,
      env,
      fetchImpl
    });
    app.agentSnapshots = createAgentDirectorySnapshots({ root: paths.agentDirectoryRoot,
      providerIdentity: resolved.personal.providerUrl });
    app.employees = createEmployeeService({ app, runtimeConfigPath });
    app.judgment = createJudgmentService({ app, engine: createJudgmentEngine({ app }),
      openStore: () => new JudgmentStore(join(dirname(runtimeConfigPath), 'judgment.sqlite')) });
    app.modelBackends = openModelBackendRuntime(paths);
    app.taskSchedules = createTaskScheduleService({ app,
      openStore: () => new TaskScheduleStore(join(dirname(runtimeConfigPath), 'task-schedules.sqlite')) });
    app.roundtableHost = createFuliRoundtableHost(app);
    app.peer = createPeerPort({ dataDir: dirname(runtimeConfigPath), host: app.roundtableHost });
    app.roundtable = createAgentRoundtable({ host: app.roundtableHost, peer: app.peer, env,
      openStore: () => createRoundtableStore(join(dirname(runtimeConfigPath), 'agent-roundtable.sqlite')) });
    // Read per call so a saved settings change applies without a restart.
    app.needsPerson = createNeedsPersonNotifier({ fetchImpl, consoleUrl: app.consoleUrl,
      readUrl: () => readRuntimeSettings(paths.runtimeSettingsPath).notifications.needsPersonUrl });
    app.explainSettings = () => describeSettings({ settings: readRuntimeSettings(paths.runtimeSettingsPath),
      capturePolicy: app.getCapturePolicy(), consoleUrl: app.consoleUrl });
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
    recallPolicyStore = new RecallPolicyStore(),
    consoleUrl = sourceConsoleUrl(null),
    projectPathResolver = resolvePersonalProjectPath,
    taskContextRegistry = null,
    providerRequestTimeoutMs = undefined,
    tokenUsageResolver = undefined, refreshPersonalToken = null
  } = {}) {
    super();
    this.graphiti = true;
    this.config = config;
    this.capturePolicyStore = capturePolicyStore;
    this.agentAccessPolicyStore = agentAccessPolicyStore;
    this.recallPolicyStore = recallPolicyStore;
    this.consoleUrl = consoleUrl;
    this.projectPathResolver = projectPathResolver;
    this.tokenUsageResolver = tokenUsageResolver;
    this.personal = new GraphitiProviderClient({
      baseUrl: config.personal.providerUrl,
      accessToken: config.personal.accessToken,
      workflowObservationToken: config.personal.workflowObservationToken ?? null,
      fetchImpl,
      requestTimeoutMs: providerRequestTimeoutMs, refreshAccessToken: refreshPersonalToken
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
    return withTaskMemorySnapshot(this, await checkpointTaskKnowledgeWorkflow(this, input));
  }

  verifyTaskCheckpoint({ sessionId, sourceApplication = 'other' }) {
    return this.taskContextRegistry.verify(sessionId, sourceApplication);
  }

  async recordDecisionTrace(input) {
    this.#assertActivePersonalSpace(input.personalSpaceId);
    return recordDecisionTraceWorkflow(this, input);
  }

  // captureScope: the write's own scope when it differs from the target, as for
  // a task checkpoint whose global preference was learned in the task's project.
  async validateCaptureSessionKnowledge(input, { captureScope = knowledgeCaptureScope(input) } = {}) {
    if ((await captureDecision(this, captureScope)).allowed) this.#prepareKnowledgeCapture(input);
  }

  async preflightPersonalKnowledgeCaptures(inputs) {
    return preflightTaskCaptures(this.personal, inputs, input => this.#prepareKnowledgeCapture(input));
  }

  async captureSessionKnowledge(input, { captureScope = knowledgeCaptureScope(input) } = {}) {
    const capture = await captureDecision(this, captureScope);
    if (!capture.allowed) return { route: 'disabled', ...captureDisabled(capture) };
    const { episode, workspace, commit } = this.#prepareKnowledgeCapture(input);
    if (input.targetKind === 'personal') {
      const result = await this.personal.commit(commit);
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
    const capture = await captureDecision(this, { sourceApplication: input.sourceApplication,
      personalProjectId: input.personalProjectId ?? null, sessionId: input.hostSessionId ?? null });
    if (!capture.allowed) return { route: 'disabled', ...captureDisabled(capture) };
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
    workflow = null,
    requiredCapabilities = [],
    limit = 100,
    agentInvocation = false,
    agentToolName = 'get_collaboration_preferences'
  } = {}) {
    let projectResolution = await this.#resolvePreferenceProject({ personalProjectId, projectPath });
    if (projectResolution.repositoryProjectId && agentInvocation && TASK_ENTRY_TOOLS.has(agentToolName)
      && (await captureDecision(this, { sourceApplication, projectPath, sessionId,
        personalProjectId: projectResolution.repositoryProjectId })).allowed) {
      // Every task gets a FULI Agent, so a task in an unregistered repository
      // registers it, unless neither the folder nor the project it would
      // become is recorded.
      projectResolution = await registerRepositoryProject(this, projectResolution, { sessionId, projectPath });
    }
    projectResolution = await resolveTaskEntryProject(this, projectResolution, {
      sessionId, sourceSessionId, sourceApplication, agentInvocation, agentToolName, projectAgentId, taskPrompt
    });
    const preferences = await taskEntryPreferences(this, projectResolution, {
      personalProjectId, projectAgentId, projectPath, taskPrompt, sourceApplication,
      sourceSessionId, sessionId, turnId, workKind, workflow, requiredCapabilities,
      limit, agentInvocation, agentToolName
    }, (items, toolName) => this.#recordAgentViews(items, toolName, { sourceApplication, projectPath,
      personalProjectId: projectResolution.personalProjectId, sessionId: sessionId ?? sourceSessionId }));
    return finishTaskEntryPreferences(this, preferences, { agentInvocation, agentToolName,
      sessionId, sourceApplication, sourceSessionId, taskPrompt, workKind, workflow });
  }

  readTaskPreferences(input) { return readTaskPreferences(this, input); }

  async getUserTasteSkill({
    personalProjectId = null,
    projectPath = null,
    taskPrompt = null,
    limit = 100,
    sourceApplication = 'other'
  } = {}) {
    const context = await this.getCollaborationPreferences({
      personalProjectId,
      projectPath,
      taskPrompt,
      limit,
      sourceApplication,
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
      agent_receipt: context.agent_receipt,
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

  // FULI's project for a directory, by the rules task entry uses: a
  // repository root, or the original repository of a worktree.
  resolveProjectPath(projectPath) {
    return this.#resolvePreferenceProject({ personalProjectId: null, projectPath });
  }

  searchKnowledge(input) {
    return searchFederatedKnowledge(this, input, {
      workspaceFor: providerUrl => this.#workspace(providerUrl),
      recordAgentViews: (items, toolName) => this.#recordAgentViews(items, toolName, {
        sourceApplication: input.sourceApplication, personalProjectId: input.personalProjectId ?? null,
        sessionId: input.sourceSessionId ?? null })
    });
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
    agentToolName = 'get_knowledge_graph',
    sourceApplication = null
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
        ], agentToolName, { sourceApplication, personalProjectId });
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

  async knowledgeTags(operation, input) {
    this.#assertActivePersonalSpace(input.personalSpaceId);
    return knowledgeTags(this, operation, input);
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
    agentToolName = 'search_human_knowledge_changes',
    sourceApplication = null
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
        agentToolName,
        { sourceApplication }
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
      profile: providerProjectProfile(input.profile),
      ...(input.createOnly === true ? { create_only: true } : {})
    });
  }

  async listPersonalProjects(input = {}) {
    const personalSpaceId = input.personalSpaceId ?? this.config.personal.spaceId;
    if (personalSpaceId !== this.config.personal.spaceId) {
      throw new TypeError('Personal projects must use the active personal space');
    }
    return this.personal.listPersonalProjects(personalSpaceId);
  }

  async listProjectRelationWeights(input = {}) {
    const personalSpaceId = input.personalSpaceId ?? this.config.personal.spaceId;
    if (personalSpaceId !== this.config.personal.spaceId) {
      throw new TypeError('Project relation weights must use the active personal space');
    }
    // The authenticated observation reader filters temporary/archived projects
    // and applies the same directional thresholds as the graph projection.
    const observations = await this.personal.readProjectMemoryUsage(personalSpaceId);
    return observations.map(row => ({ fromProjectId: row.source_project_id, toProjectId: row.target_project_id,
      tier: row.statistics.tier, recent30dCount: row.statistics.recent30dCount }));
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

  // The stored settings, for settings surfaces. Write decisions ask captureDecision().
  getCapturePolicy() {
    return this.capturePolicyStore.read();
  }

  // Which stored settings a decision was made under; see captureSettingsVersion().
  getCapturePolicyVersion() {
    return this.capturePolicyStore.version();
  }

  // See advanceCaptureSettingsVersion().
  advanceCapturePolicyVersion() {
    return this.capturePolicyStore.advanceVersion();
  }

  updateCapturePolicy(input) {
    return this.capturePolicyStore.update(input);
  }

  getRecallPolicy() {
    return this.recallPolicyStore.read();
  }

  updateRecallPolicy(input) {
    return this.recallPolicyStore.update(input);
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
      recallPolicy: this.getRecallPolicy(),
      publicProvider: { configured, status: publicStatus },
      capabilities: aggregatePublicCapabilities(
        this.workspaces, providers.workspaces, spaces.projects
      )
    };
  }

  close() { this.judgment?.close(); this.taskSchedules?.close(); this.modelBackends?.close(); this.roundtable?.close(); this.peer?.close(); return this.employees?.close(); }

  // View records rank knowledge by what a session looked at: a behavior trace
  // that stops with automatic recording. Reading itself needs none (rec#11 D-01).
  async #recordAgentViews(items, toolName, scope) {
    if (!items.length || !(await captureDecision(this, scope)).allowed) return;
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
      return { episode, commit: providerPersonalCommit(input, episode, this.config.personal.spaceId) };
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

function knowledgeCaptureScope(input) {
  return { sourceApplication: input?.sourceApplication, personalProjectId: input?.personalProjectId ?? null,
    sessionId: input?.sessionId ?? null };
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
