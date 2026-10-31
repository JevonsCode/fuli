import { dirname } from 'node:path';
import { closeLocalRuntimes, openLocalRuntimes } from './local-runtimes.js';
import { withTaskMemorySnapshot } from './project-agent-memory.js';

import { GraphitiProviderClient } from './provider-client.js';
import {
  aggregatePublicCapabilities,
  createWorkspaceProvider
} from './workspace-provider-client.js';
import {
  personalTokenRefresher,
  readGraphRuntimeConfig
} from './runtime-config.js';
import {
  CapturePolicyStore,
  capturePolicyPathForRuntime
} from './capture-policy.js';
import { createCaptureChanges } from './capture-change-confirmation.js';
import { createCaptureOnboarding } from './capture-onboarding.js';
import { SessionCapturePauseStore, sessionCapturePausePathForRuntime } from './capture-session-pause.js';
import { setSessionCapturePause } from './session-capture-pause-request.js';
import { readOwnSessionRecords } from './session-records.js';
import {
  AgentAccessPolicyStore,
  agentAccessPolicyPathForRuntime
} from './agent-access-policy.js';
import { RecallPolicyStore, recallPolicyPathForRuntime } from './recall-policy.js';
import {
  sourceConsoleUrl
} from './source-marker.js';
import { resolvePersonalProjectPath } from './project-path-context.js';
import { ProviderTaskContextRegistry } from '../mcp/provider-task-context-registry.js';
import { readTaskPreferences } from './task-preference-reader.js';
import { resolveSetupPaths } from '../setup/paths.js';
import { createNeedsPersonNotifier } from '../notifications/needs-person.js';
import { fuliLinkOrigin } from '../desktop/fuli-links.js';
import { readRuntimeSettings } from '../system/runtime-settings.js';
import { describeSettings } from '../system/settings-guide.js';
import {
  checkpointTaskKnowledge as checkpointTaskKnowledgeWorkflow,
  discoverCommonKnowledgeCandidates as discoverCommonKnowledgeCandidatesWorkflow,
  discoverPersonalGlobalPreferenceCandidates as
    discoverPersonalGlobalPreferenceCandidatesWorkflow,
  applyPersonalGlobalPreferenceDecision as
    applyPersonalGlobalPreferenceDecisionWorkflow,
  recordDecisionTrace as recordDecisionTraceWorkflow,
  recordKnowledgeFeedback as recordKnowledgeFeedbackWorkflow,
  previewPersonalGlobalPreferenceDecision as
    previewPersonalGlobalPreferenceDecisionWorkflow
} from './agent-knowledge-workflows.js';
import {
  ProjectAgentControlPlaneApplication,
  projectAgentControlPlaneHooks
} from './project-agent-control-plane.js';
import {
  finishKnowledgeReview as finishKnowledgeReviewWorkflow,
  listKnowledgeReviewCandidates as listKnowledgeReviewCandidatesWorkflow,
  readKnowledgeReviewDecision as readKnowledgeReviewDecisionWorkflow,
  recordKnowledgeReviewProgress as recordKnowledgeReviewProgressWorkflow,
  startKnowledgeReview as startKnowledgeReviewWorkflow
} from './knowledge-review.js';
import { beginTaskEntry } from './task-entry-preferences.js';
import { transcriptCaptureLedger } from '../conversations/transcript-capture-gap.js';
import { knowledgeTags } from './knowledge-tags.js';
import { assertActivePersonalSpace } from './active-personal-space.js';
import { resolvePreferenceProject } from './preference-project-resolution.js';
import { assertSafeKnowledgeMutation } from './knowledge-credential-guard.js';
import {
  captureSessionKnowledge,
  preflightPersonalKnowledgeCaptures,
  validateCaptureSessionKnowledge
} from './session-knowledge-capture.js';
import {
  listWorkflowCandidates,
  recommendNextWorkflowSteps,
  recordWorkflowTransitionObservation
} from './workflow-learning.js';
import { collaborationPreferencesAtEntry, getUserTasteSkill } from './collaboration-preference-entry.js';
import {
  getKnowledgeGraph,
  searchCurrentProjectKnowledge,
  searchKnowledge
} from './knowledge-graph-reads.js';
import {
  applyCommonKnowledgePromotion,
  applyKnowledgeProjectAction,
  confirmKnowledgeBatch,
  previewCommonKnowledgePromotion,
  previewKnowledgeProjectAction,
  reassignKnowledgeItem,
  recordKnowledgeUsage,
  reviseKnowledgeItem,
  setPersonalPreferenceScope
} from './knowledge-curation.js';
import {
  completePreferenceConflict,
  deferPreferenceConflict,
  listPreferenceConflicts,
  resolveDeferredPreferenceConflict
} from './preference-conflict-requests.js';
import { reviewHumanChange, searchHumanChanges } from './human-knowledge-changes.js';
import {
  deletePublicProject,
  listKnowledgeSpaces,
  listProjectReleases,
  publishPersonalProject,
  subscribePublicProject,
  unsubscribePublicProject
} from './public-projects.js';
import {
  createProjectRelation,
  listProjectRelations,
  reviewProjectRelation
} from './public-project-relations.js';
import {
  listPersonalProjects,
  listProjectRelationWeights,
  upsertPersonalProject
} from './personal-projects.js';
import {
  listPersonalReviewQueue,
  listReviewQueue,
  reconcilePersonalSubmissions,
  reviewPersonalDraft,
  reviewProposal
} from './publication-review-queues.js';

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
    sessionCapturePauseStore: new SessionCapturePauseStore(sessionCapturePausePathForRuntime(runtimeConfigPath)),
    agentAccessPolicyStore: agentAccessPolicyStore ?? new AgentAccessPolicyStore(
      agentAccessPolicyPathForRuntime(runtimeConfigPath)
    ),
    recallPolicyStore: recallPolicyStore ?? new RecallPolicyStore(recallPolicyPathForRuntime(runtimeConfigPath)),
    tokenUsageResolver,
    consoleUrl: sourceConsoleUrl(runtimeConfigPath),
    fuliLinkOrigin: fuliLinkOrigin(),
    runtimeConfigPath,
    providerRequestTimeoutMs: providerRequestTimeoutFromEnv(env),
    refreshPersonalToken: personalTokenRefresher(runtimeConfigPath, resolved.personal)
  });
  if (typeof runtimeConfigPath === 'string' && runtimeConfigPath) {
    const paths = resolveSetupPaths({ dataDir: dirname(runtimeConfigPath) });
    openLocalRuntimes(app, { runtimeConfigPath, paths, env, fetchImpl });
    // Read per call so a saved settings change applies without a restart.
    app.needsPerson = createNeedsPersonNotifier({ fetchImpl, consoleUrl: app.consoleUrl,
      readUrl: () => readRuntimeSettings(paths.runtimeSettingsPath).notifications.needsPersonUrl });
    app.explainSettings = () => describeSettings({ settings: readRuntimeSettings(paths.runtimeSettingsPath),
      capturePolicy: app.getCapturePolicy(), consoleUrl: app.consoleUrl });
    app.agentNamingStyle = () => readRuntimeSettings(paths.runtimeSettingsPath).agentNamingStyle;
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

// The application's public methods. Each capability lives in its own module;
// a method here only wires the request to that module or to a workflow.
export class FederatedGraphApplication extends ProjectAgentControlPlaneApplication {
  constructor(config, {
    fetchImpl = globalThis.fetch,
    capturePolicyStore = new CapturePolicyStore(),
    sessionCapturePauseStore = new SessionCapturePauseStore(),
    agentAccessPolicyStore = new AgentAccessPolicyStore(),
    recallPolicyStore = new RecallPolicyStore(),
    consoleUrl = sourceConsoleUrl(null),
    // `fuli:/` when receipt links can be fuli:// links (src/desktop/fuli-links.js), else null.
    fuliLinkOrigin = () => null,
    projectPathResolver = resolvePersonalProjectPath,
    taskContextRegistry = null,
    providerRequestTimeoutMs = undefined,
    tokenUsageResolver = undefined,
    refreshPersonalToken = null,
    // The runtime directory whose transcript ledgers this application's hooks
    // keep; none for an application that only lives in memory.
    runtimeConfigPath = null
  } = {}) {
    super();
    this.graphiti = true;
    this.config = config;
    this.capturePolicyStore = capturePolicyStore;
    // An Agent's long-term capture change waits for the person's confirmed preview (rec#5 C4-2).
    const captureChangeReads = { listProjects: () => this.listPersonalProjects(), consoleUrl,
      taskContext: (token, client) => this.taskContextRegistry.context(token, client) };
    this.captureChanges = createCaptureChanges(capturePolicyStore, captureChangeReads);
    this.captureOnboarding = createCaptureOnboarding(capturePolicyStore);
    this.sessionCapturePauseStore = sessionCapturePauseStore;
    this.runtimeConfigPath = runtimeConfigPath;
    this.agentAccessPolicyStore = agentAccessPolicyStore;
    this.recallPolicyStore = recallPolicyStore;
    this.consoleUrl = consoleUrl;
    this.fuliLinkOrigin = fuliLinkOrigin;
    this.projectPathResolver = projectPathResolver;
    this.tokenUsageResolver = tokenUsageResolver;
    this.personal = new GraphitiProviderClient({
      baseUrl: config.personal.providerUrl,
      accessToken: config.personal.accessToken,
      workflowObservationToken: config.personal.workflowObservationToken ?? null,
      fetchImpl,
      requestTimeoutMs: providerRequestTimeoutMs,
      refreshAccessToken: refreshPersonalToken
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
    return beginTaskEntry(this, input);
  }

  async checkpointTaskKnowledge(input) {
    return withTaskMemorySnapshot(this, await checkpointTaskKnowledgeWorkflow(this, input));
  }

  verifyTaskCheckpoint({ sessionId, sourceApplication = 'other' }) {
    return this.taskContextRegistry.verify(sessionId, sourceApplication);
  }

  async recordDecisionTrace(input) {
    assertActivePersonalSpace(this, input.personalSpaceId);
    return recordDecisionTraceWorkflow(this, input);
  }

  async validateCaptureSessionKnowledge(input, options) {
    return validateCaptureSessionKnowledge(this, input, options);
  }

  async preflightPersonalKnowledgeCaptures(inputs) {
    return preflightPersonalKnowledgeCaptures(this, inputs);
  }

  async captureSessionKnowledge(input, options) {
    return captureSessionKnowledge(this, input, options);
  }

  async recordWorkflowTransitionObservation(input) {
    return recordWorkflowTransitionObservation(this, input);
  }

  getCollaborationPreferences(input) {
    return collaborationPreferencesAtEntry(this, input);
  }

  readTaskPreferences(input) {
    return readTaskPreferences(this, input);
  }

  async getUserTasteSkill(input) {
    return getUserTasteSkill(this, input);
  }

  // FULI's project for a directory, by the rules task entry uses: a
  // repository root, or the original repository of a worktree.
  resolveProjectPath(projectPath) {
    return resolvePreferenceProject(this, { personalProjectId: null, projectPath });
  }

  searchKnowledge(input) {
    return searchKnowledge(this, input);
  }

  async searchCurrentProjectKnowledge(input) {
    return searchCurrentProjectKnowledge(this, input);
  }

  async discoverCommonKnowledgeCandidates(input) {
    assertActivePersonalSpace(this, input.personalSpaceId);
    return discoverCommonKnowledgeCandidatesWorkflow(this, input);
  }

  async discoverPersonalGlobalPreferenceCandidates(input) {
    assertActivePersonalSpace(this, input.personalSpaceId);
    return discoverPersonalGlobalPreferenceCandidatesWorkflow(this, input);
  }

  async previewPersonalGlobalPreferenceDecision(input) {
    assertActivePersonalSpace(this, input.personalSpaceId);
    assertSafeKnowledgeMutation(input);
    return previewPersonalGlobalPreferenceDecisionWorkflow(this, input);
  }

  async applyPersonalGlobalPreferenceDecision(input) {
    assertActivePersonalSpace(this, input.personalSpaceId);
    assertSafeKnowledgeMutation(input);
    return applyPersonalGlobalPreferenceDecisionWorkflow(this, input);
  }

  async previewCommonKnowledgePromotion(input) {
    return previewCommonKnowledgePromotion(this, input);
  }

  async applyCommonKnowledgePromotion(input) {
    return applyCommonKnowledgePromotion(this, input);
  }

  async getKnowledgeGraph(input, ownerReads) {
    return getKnowledgeGraph(this, input, ownerReads);
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

  async readKnowledgeReviewDecision(input) {
    return readKnowledgeReviewDecisionWorkflow(this, input);
  }

  async finishKnowledgeReview(input) {
    return finishKnowledgeReviewWorkflow(this, input);
  }

  async listWorkflowCandidates(input) {
    return listWorkflowCandidates(this, input);
  }

  async recommendNextWorkflowSteps(input) {
    return recommendNextWorkflowSteps(this, input);
  }

  async recordKnowledgeUsage(input) {
    return recordKnowledgeUsage(this, input);
  }

  async recordKnowledgeFeedback(input) {
    assertActivePersonalSpace(this, input.personalSpaceId);
    assertSafeKnowledgeMutation({
      items: input.items.map((item) => ({
        existenceReason: item.reason,
        quadrantReason: item.evidenceSummary
      }))
    });
    return recordKnowledgeFeedbackWorkflow(this, input);
  }

  async reviseKnowledgeItem(input) {
    return reviseKnowledgeItem(this, input);
  }

  async knowledgeTags(operation, input) {
    assertActivePersonalSpace(this, input.personalSpaceId);
    return knowledgeTags(this, operation, input);
  }

  async listPreferenceConflicts(input, ownerReads) {
    return listPreferenceConflicts(this, input, ownerReads);
  }

  async deferPreferenceConflict(input, ownerReads) {
    return deferPreferenceConflict(this, input, ownerReads);
  }

  async resolveDeferredPreferenceConflict(input) {
    return resolveDeferredPreferenceConflict(this, input);
  }

  async completePreferenceConflict(input, ownerReads) {
    return completePreferenceConflict(this, input, ownerReads);
  }

  async confirmKnowledgeBatch(input) {
    return confirmKnowledgeBatch(this, input);
  }

  async reassignKnowledgeItem(input) {
    return reassignKnowledgeItem(this, input);
  }

  async setPersonalPreferenceScope(input) {
    return setPersonalPreferenceScope(this, input);
  }

  async previewKnowledgeProjectAction(input) {
    return previewKnowledgeProjectAction(this, input);
  }

  async applyKnowledgeProjectAction(input) {
    return applyKnowledgeProjectAction(this, input);
  }

  async searchHumanChanges(input) {
    return searchHumanChanges(this, input);
  }

  async reviewHumanChange(input) {
    return reviewHumanChange(this, input);
  }

  async listKnowledgeSpaces() {
    return listKnowledgeSpaces(this);
  }

  async subscribePublicProject(input) {
    return subscribePublicProject(this, input);
  }

  async unsubscribePublicProject(input) {
    return unsubscribePublicProject(this, input);
  }

  async publishPersonalProject(input) {
    return publishPersonalProject(this, input);
  }

  async listProjectReleases(input) {
    return listProjectReleases(this, input);
  }

  async deletePublicProject(input) {
    return deletePublicProject(this, input);
  }

  async upsertPersonalProject(input) {
    return upsertPersonalProject(this, input);
  }

  async listPersonalProjects(input) {
    return listPersonalProjects(this, input);
  }

  async listProjectRelationWeights(input) {
    return listProjectRelationWeights(this, input);
  }

  async createProjectRelation(input) {
    return createProjectRelation(this, input);
  }

  async listProjectRelations(input) {
    return listProjectRelations(this, input);
  }

  async reviewProjectRelation(input) {
    return reviewProjectRelation(this, input);
  }

  async listPersonalReviewQueue(input, ownerReads) {
    return listPersonalReviewQueue(this, input, ownerReads);
  }

  async readRoleSuggestions({ limit } = {}) {
    const personalSpaceId = this.config.personal.spaceId;
    await this.knowledgeRecoveryGate?.refresh(personalSpaceId);
    return this.roleSuggestions.list({ personalSpaceId, limit });
  }

  reconcilePersonalSubmissions(options, ownerReads) {
    return reconcilePersonalSubmissions(this, options, ownerReads);
  }

  async reviewPersonalDraft(input, ownerReads) {
    return reviewPersonalDraft(this, input, ownerReads);
  }

  async listReviewQueue(input) {
    return listReviewQueue(this, input);
  }

  async reviewProposal(input) {
    return reviewProposal(this, input);
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

  // The person's own change (console): saved at once.
  updateCapturePolicy(input) {
    return this.capturePolicyStore.update(input);
  }

  // The session layer the capture decision reads (rec#5 C3); see captureDecision().
  getSessionCapturePause(sessionId) {
    return this.sessionCapturePauseStore.state(sessionId);
  }

  hasSessionWithoutCapture(sourceApplication) {
    return this.sessionCapturePauseStore.anyWithoutCapture(sourceApplication);
  }

  hasStoppedSession(sourceApplication = null) {
    return this.sessionCapturePauseStore.anyStopped(sourceApplication);
  }

  setSessionCapturePause(sessionId, change) {
    return this.sessionCapturePauseStore.set(sessionId, change);
  }

  // FULI on or off for one host session and for new sessions (rec#5 C3b);
  // decisions read it through session-layer-decision.js.
  setSessionFuli(sessionId, change) {
    return this.sessionCapturePauseStore.setEnabled(sessionId, change);
  }

  sessionFuliDefault() {
    return this.sessionCapturePauseStore.defaultSetting();
  }

  setSessionFuliDefault(enabled) {
    return this.sessionCapturePauseStore.setDefault(enabled);
  }

  // A session seen at task entry keeps the default it started under.
  pinSessionFuliDefault(sessionId, sourceApplication, start) {
    return this.sessionCapturePauseStore.pinDefault(sessionId, sourceApplication, start);
  }

  // The local record of how this session's native transcript was last
  // handled, which a pause writes to first (session-capture-pause-request.js).
  sessionTranscriptLedger(sourceApplication, sessionId) {
    return this.runtimeConfigPath
      ? transcriptCaptureLedger(this.runtimeConfigPath, { session_id: sessionId }, sourceApplication) : null;
  }

  // An Agent's "这次别记" / "继续记" for the session of its current task.
  pauseSessionCapture(input) {
    return setSessionCapturePause(this, input);
  }

  // An Agent's "这次都记了我什么" for the session of its current task (rec#5 C6).
  readOwnSessionRecords(input) {
    return readOwnSessionRecords(this, input);
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
      captureOnboarding: this.captureOnboarding.state(),
      agentAccessPolicy: this.getAgentAccessPolicy(),
      recallPolicy: this.getRecallPolicy(),
      publicProvider: { configured, status: publicStatus },
      capabilities: aggregatePublicCapabilities(
        this.workspaces, providers.workspaces, spaces.projects
      )
    };
  }

  close() {
    return closeLocalRuntimes(this);
  }

  [projectAgentControlPlaneHooks.assertActivePersonalSpace](personalSpaceId) {
    assertActivePersonalSpace(this, personalSpaceId);
  }

  async [projectAgentControlPlaneHooks.resolvePreferenceProject](input) {
    return resolvePreferenceProject(this, input);
  }

}
