import { AGENT_COLLABORATION_DEFINITIONS } from './agent-collaboration-definitions.js';
import { AGENT_CONVERSATION_DEFINITIONS } from './agent-conversation-definitions.js';
import { PROJECT_AGENT_MEMORY_DEFINITIONS } from './project-agent-memory-definitions.js';
import { AGENT_DISMISSAL_DEFINITIONS } from './agent-dismissal-definitions.js';
import {
  nullableProjectAgentStatus,
  projectAgentAssignmentEndInput,
  projectAgentAssignmentInput,
  projectAgentAssignmentReplaceInput,
  projectAgentAssignmentStatus,
  projectAgentOccupation,
  projectAgentProfile,
  projectAgentTaskActivityInput,
  projectAgentTaskCoordinateInput,
  projectAgentTaskSubmitInput,
  recruitmentConfirmationMode,
  recruitmentDecision,
  recruitmentStatus
} from './project-agent-definitions.js';
import { dateTime, id, shortText } from './graph-tool-fields.js';
import {
  arraySchema,
  booleanSchema,
  boundedString,
  enumSchema,
  integerSchema,
  nullableStringSchema,
  objectSchema,
  stringSchema
} from './schema.js';

// Project Agents: directory, context, assignments, tasks, runtime leases,
// teams and recruitment.
export const PROJECT_AGENT_TOOL_DEFINITIONS = [
  {
    name: 'upsert_project_agent',
    title: 'WRITE · Create or update a project Agent',
    description: 'Create or update one model-independent long-lived Agent bound to an existing local personal project. A new Agent needs occupation.role, one built-in role key (engineering, testing, qa_automation, design, …); tags are optional and must already be active in the person\'s occupation catalog. This does not start a model or copy project knowledge into the Agent.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      personalProjectId: nullableStringSchema(),
      agentId: boundedString(128),
      profile: projectAgentProfile,
      occupation: {
        ...projectAgentOccupation,
        description: 'role: one built-in role key. tags: optional; each must already be active in the person\'s occupation catalog.'
      }
    }, ['personalSpaceId', 'agentId', 'profile'])
  },
  {
    name: 'get_agent_naming_style',
    title: 'READ · Get the Agent naming style',
    description: 'Before proposing a new Agent\'s displayName: the person\'s saved naming style, or null (generated names). Only the person changes it.',
    inputSchema: objectSchema({})
  },
  {
    name: 'list_project_agents',
    title: 'READ · Find project Agents by responsibility',
    description: 'Resolve the exact local project from projectPath and return its lightweight Agent directory. Optionally filter active/inactive/archived records or find Agents whose capabilities or responsibility match a capability query. This never loads another Agent\'s private memory.',
    inputSchema: objectSchema({
      projectPath: boundedString(4096),
      personalProjectId: {
        ...nullableStringSchema(), minLength: 1, maxLength: 128,
        description: 'Explicit existing project ID when the directory has no exact match. A conflicting exact path match is rejected.'
      },
      status: nullableProjectAgentStatus,
      capability: nullableStringSchema()
    }, ['projectPath'])
  },
  {
    name: 'get_project_agent_context',
    title: 'READ · Assemble one project Agent context',
    description: 'Resolve one active project Agent and assemble only the context needed for the task: personal-global rules, exact and authorized inherited project knowledge, this Agent\'s preferences and memory, and focused query results. It excludes every other project Agent. Fuli remains a control layer; the calling host Agent performs reasoning and execution.',
    inputSchema: objectSchema({
      projectPath: boundedString(4096),
      personalProjectId: {
        ...nullableStringSchema(), minLength: 1, maxLength: 128,
        description: 'Explicit existing project ID when the directory has no exact match. A conflicting exact path match is rejected.'
      },
      agentId: boundedString(128),
      queries: arraySchema(shortText, { minItems: 1, maxItems: 10 }),
      limitPerQuery: integerSchema({ minimum: 1, maximum: 50 }),
      includePending: booleanSchema()
    }, ['projectPath', 'agentId', 'queries'])
  },
  {
    name: 'get_project_agent',
    title: 'READ · Get one space-level Agent',
    description: 'Read one FULI space-level Agent identity, assignments, recruitment source, memory boundary, configured status, observed clients, and actual task state. Configured status is not a connection or online claim.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      personalProjectId: nullableStringSchema(),
      agentId: id
    }, ['personalSpaceId', 'agentId'])
  },
  ...PROJECT_AGENT_MEMORY_DEFINITIONS,
  ...AGENT_CONVERSATION_DEFINITIONS,
  ...AGENT_COLLABORATION_DEFINITIONS,
  ...AGENT_DISMISSAL_DEFINITIONS,
  {
    name: 'cleanup_test_project_agents',
    title: 'WRITE · Archive test Agent roles',
    description: 'TEST-ONLY. Archive only test-marked Project Agents for one explicit test source through the Provider. Disabled on default MCP/HTTP surfaces unless FULI_ENABLE_TEST_TOOLS=1. Durable production identities are not touched; the result reports the number archived for cleanup verification.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      testSource: boundedString(256)
    }, ['personalSpaceId', 'testSource'])
  },
  {
    name: 'create_project_agent_assignment',
    title: 'WRITE · Assign an Agent to a project',
    description: 'Create one project-specific Agent assignment. The same space-level Agent may have many assignments; responsibility, capabilities, model override, and memory boundary stay project-scoped.',
    inputSchema: projectAgentAssignmentInput
  },
  {
    name: 'list_project_agent_assignments',
    title: 'READ · List Agent assignments',
    description: 'List project-Agent assignments and their full active/ended history. Never infer a runtime connection from assignment status.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      personalProjectId: nullableStringSchema(),
      agentId: nullableStringSchema(),
      status: { ...projectAgentAssignmentStatus, type: ['string', 'null'] }
    }, ['personalSpaceId'])
  },
  {
    name: 'end_project_agent_assignment',
    title: 'WRITE · End an Agent assignment',
    description: 'End one project-Agent assignment with an expected revision. Stale revisions are rejected; the Agent and task history remain intact.',
    inputSchema: projectAgentAssignmentEndInput
  },
  {
    name: 'replace_project_agent_assignment',
    title: 'WRITE · Replace an Agent assignment',
    description: 'Atomically end one assignment and create its replacement, preserving replacement history and explicit reason.',
    inputSchema: projectAgentAssignmentReplaceInput
  },
  {
    name: 'coordinate_project_agent_task',
    title: 'WRITE · Prepare a host-executed Agent team',
    description: 'Resolve the exact local project (ambiguity requires exact selection), or create isolated temporary task scope if none matches. The Provider coordinator routes one durable task and builds isolated context per selected lead/collaborator. Pass current taskContextToken to bind temporary scope and any newly recruited lead to the owned lifecycle; otherwise use stable sourceSessionId and idempotencyKey for retries. Temporary projects retain audit history, never implicitly bind directories, and default to audited task-only recruitment under existing AR policy; durable recruitment still requires explicit request. AR should derive recruitmentProfile.character from role responsibilities and preserve user expectations; never present configured traits as proven growth. Fuli persists identity, staffing, memory scope. The host must start real workers, report concrete evidence, and finish their lifecycle; routing recommendations never prove worker startup. start:false assigns the task to the backlog without starting a worker.',
    inputSchema: projectAgentTaskCoordinateInput
  },
  {
    name: 'acquire_runtime_lease',
    title: 'WRITE · Keep adaptive runtime awake',
    description: 'Acquire a host-held local adaptive-runtime lease before starting real project Agent workers. The MCP process heartbeats the lease until release; disabled adaptive mode returns a safe no-op handle. Use graph for Provider/database work and executor only for an executor managed by Fuli.',
    inputSchema: objectSchema({
      kind: enumSchema(['graph', 'executor']),
      executorId: nullableStringSchema(),
      owner: boundedString(256)
    }, ['kind', 'owner'])
  },
  {
    name: 'refresh_runtime_lease',
    title: 'WRITE · Refresh adaptive runtime lease',
    description: 'Explicitly refresh one lease owned by this MCP process. Automatic heartbeat normally makes this unnecessary; a missing or expired handle returns refreshed=false.',
    inputSchema: objectSchema({ leaseId: id }, ['leaseId'])
  },
  {
    name: 'release_runtime_lease',
    title: 'WRITE · Release adaptive runtime lease',
    description: 'Stop the heartbeat and release one host-held adaptive-runtime lease in a finally path. Repeated release is safe and returns released=false.',
    inputSchema: objectSchema({ leaseId: id }, ['leaseId'])
  },
  {
    name: 'submit_project_agent_task',
    title: 'WRITE · Submit a routed Agent task',
    description: 'Submit a durable control-plane task; grouped Agent staffing requires the current host taskContextToken. Completion needs a passed exact-revision quality gate via record_agent_verification with actual run evidence. Prefer matching durable Agents; creates no anonymous worker. Locked executor policy and explicit user priorities remain binding. Provider retains routing, boundaries and actual execution audit. AR derives character from responsibilities, preserves user expectations and distinguishes configured traits from proven growth.',
    inputSchema: projectAgentTaskSubmitInput
  },
  {
    name: 'view_project_agent_task',
    title: 'READ · View task, routing, and events',
    description: 'View one task with lead/collaborator assignments, routing decision, effective model strategy, source client/session, event history, actual executor/model, routing rule, and fallback audit. Missing connected state is not synthesized.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      personalProjectId: id,
      taskId: id,
      includeEvents: booleanSchema()
    }, ['personalSpaceId', 'taskId'])
  },
  {
    name: 'record_project_agent_task_activity',
    title: 'WRITE · Record task activity',
    description: 'Record real task/worker activity and optional source-labelled cumulative token usage; never estimate. workerStatus requires workerId and agentId. Supply actualExecutorId, actualModelProvider, actualModel together only with matching authorized preflight evidence; otherwise omit all three, report observed workerRuntime, and explain mismatch in summary. Terminal activity with valid actual execution automatically records routing outcome.',
    inputSchema: projectAgentTaskActivityInput
  },
  {
    name: 'view_project_agent_activity',
    title: 'READ · View Agent terminal activity',
    description: 'Return actual per-Agent daily completed/failed/cancelled activity and verifiable summaries. No history is fabricated and configured Agent status is not treated as running state.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      personalProjectId: id,
      agentId: id,
      fromDate: nullableStringSchema(),
      toDate: nullableStringSchema()
    }, ['personalSpaceId', 'agentId'])
  },
  {
    name: 'get_project_agent_coordination_policy',
    title: 'READ · Get project Agent continuity policy',
    description: 'Read project policy, membership, sub-teams and threshold.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      personalProjectId: id
    }, ['personalSpaceId', 'personalProjectId'])
  },
  {
    name: 'get_project_team',
    title: 'READ · Get project team',
    description: 'Read active team, sub-teams, collaborators, peers, reporting lines and unavailable roles; no private memory.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      personalProjectId: id
    }, ['personalSpaceId', 'personalProjectId'])
  },
  {
    name: 'update_project_agent_coordination_policy',
    title: 'WRITE · Set project Agent continuity policy',
    description: 'Set project policy and sub-teams. Omitted fields persist; [] clears groups. Send expectedUpdatedAt from a fresh read. AR/managers stay peers; starts no worker.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      personalProjectId: id,
      askBeforeRecruitment: booleanSchema(),
      autoReusePreviousAgent: booleanSchema(),
      autoGrowTeam: booleanSchema(),
      teamLeadAgentId: nullableStringSchema(),
      teamMemberAgentIds: arraySchema(id, { maxItems: 32, uniqueItems: true }),
      subTeams: arraySchema(objectSchema({ id, name: stringSchema({ minLength: 1, maxLength: 120 }), leadAgentId: id,
        memberAgentIds: arraySchema(id, { maxItems: 32, uniqueItems: true }) }, ['id', 'name', 'leadAgentId', 'memberAgentIds']), { maxItems: 32 }),
      subTeamSuggestionThreshold: integerSchema({ minimum: 1, maximum: 32 }),
      expectedUpdatedAt: { ...dateTime, type: ['string', 'null'] }
    }, [
      'personalSpaceId', 'personalProjectId',
      'askBeforeRecruitment', 'autoReusePreviousAgent'
    ])
  },
  {
    name: 'get_project_agent_recruitment_policy',
    title: 'READ · Get recruitment policy',
    description: 'Deprecated: read the legacy stored space setting, which does not control recruitment. Use get_project_agent_coordination_policy for the effective exact-project switches.',
    inputSchema: objectSchema({ personalSpaceId: id }, ['personalSpaceId'])
  },
  {
    name: 'update_project_agent_recruitment_policy',
    title: 'WRITE · Set recruitment policy',
    description: 'Deprecated compatibility storage only; this does not change recruitment authorization. Use update_project_agent_coordination_policy with the exact project and askBeforeRecruitment instead. The response warns that this legacy value is not effective.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      confirmationMode: recruitmentConfirmationMode
    }, ['personalSpaceId', 'confirmationMode'])
  },
  {
    name: 'list_project_agent_recruitments',
    title: 'READ · List recruitment records',
    description: 'List auditable AR recruitment records with trigger client/session, role, capabilities, position kind, reason, status, and created/recruited Agent.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      personalProjectId: nullableStringSchema(),
      taskId: nullableStringSchema(),
      status: { ...recruitmentStatus, type: ['string', 'null'] }
    }, ['personalSpaceId'])
  },
  {
    name: 'decide_project_agent_recruitment',
    title: 'WRITE · Approve or cancel recruitment',
    description: 'Approve or cancel one pending AR recruitment event with an expected revision. Approval creates only the declared durable or bounded temporary role through the Provider.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      personalProjectId: id,
      recruitmentId: id,
      expectedRevision: integerSchema({ minimum: 0 }),
      decision: recruitmentDecision,
      occupation: projectAgentOccupation,
      reason: shortText
    }, ['personalSpaceId', 'personalProjectId', 'recruitmentId', 'expectedRevision', 'decision', 'reason'])
  }
];
