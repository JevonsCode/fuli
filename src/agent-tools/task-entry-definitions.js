import { checkpointCompactFields } from './checkpoint-definitions.js';
import { workingMemorySchema } from './project-agent-memory-definitions.js';
import { knowledgeUsageItems } from './knowledge-usage-definitions.js';
import { captureEpisodeFields, captureEpisodeRequired } from './knowledge-definitions.js';
import { id, shortText } from './graph-tool-fields.js';
import { arraySchema, boundedString, enumSchema, integerSchema, nullableStringSchema, objectSchema } from './schema.js';

// A task's entry, checkpoint and preference loading, which every task meets.
export const TASK_ENTRY_DEFINITIONS = [
  {
    name: 'begin_task_context',
    title: 'LIFECYCLE · Begin a Fuli-aware task',
    description: 'Supported Agent hooks call before the model processes a user prompt. Resolves the exact local project from projectPath and loads effective collaboration preferences. Uses taskPrompt transiently for bounded automatic recall of signaled stable prior facts, runbooks, URLs, decisions, releases, deployments, or authentication methods. Never stores or returns projectPath/taskPrompt. Inspect task_knowledge_recall before reasking stable context. Returns opaque taskContextToken and required agent_receipt; include agent_receipt.markdown unchanged exactly once in every final user-visible reply, including greetings/capture-disabled tasks. Fuli setup generates Claude Code/Codex UserPromptSubmit hook configuration and a Cursor task-entry adapter; configuration proves neither host loading, trust, nor execution. Use supplied hook context without repeating preference fallback. Cursor retrieves context through the Agent if its hook cannot inject it.',
    inputSchema: objectSchema({
      sessionId: id,
      turnId: id,
      workflow: boundedString(128),
      projectPath: boundedString(4096),
      personalProjectId: nullableStringSchema(),
      projectAgentId: nullableStringSchema(),
      workKind: boundedString(128),
      requiredCapabilities: arraySchema(boundedString(512), { maxItems: 16 }),
      taskPrompt: boundedString(8192)
    }, ['sessionId', 'projectPath'])
  },
  {
    name: 'checkpoint_task_knowledge',
    title: 'LIFECYCLE · Finish knowledge review',
    description: 'Record capture candidates or a meaningful task workLog once. Routine empty finishes follow entry checkpoint_guidance. Employees calling this tool supply a concise truthful workLog, even with retain_nothing. Memory changes include agentMemory with loaded revision and merged notes. capture_candidates is a bounded supported batch; proposals stay pending without valid human/source confirmation. retain_nothing skips knowledge capture. No transcripts, guesses, logs, credentials or disposable output. collaborators contains actual contributing Agent IDs only; unknown/inactive IDs are ignored. Copy returned agent_receipt.markdown unchanged.',
    inputSchema: objectSchema({
      taskContextToken: id,
      disposition: enumSchema(['capture_candidates', 'retain_nothing']),
      reason: boundedString(2000),
      workLog: objectSchema({
        status: enumSchema(['reported', 'completed', 'incomplete', 'failed', 'no_change']),
        summary: boundedString(2000)
      }, ['status', 'summary']),
      knowledgeUsage: { ...knowledgeUsageItems,
        description: 'Explicit material use only, including with retain_nothing. Atomically recorded with checkpoint preparation using the task token as taskId; retries replay the original receipt. Retrieval and automatic preference injection do not qualify. The existing Agent confirmation policy still applies.' },
      capture: objectSchema(captureEpisodeFields, captureEpisodeRequired),
      captureRouting: arraySchema(objectSchema({
        scope: enumSchema(['personal_global', 'current_project']),
        entityKeys: arraySchema(id, { minItems: 1, maxItems: 128 }),
        relationshipKeys: arraySchema(id, { maxItems: 256 }),
        sourceExcerpt: shortText
      }, ['scope', 'entityKeys', 'relationshipKeys']), { minItems: 1, maxItems: 2,
        description: 'Use with one capture. Partition every entity/relationship key exactly once into unique scopes; each scope needs an entity, and relationships stay with their endpoints. Shared episode metadata; optional sourceExcerpt overrides its evidence. Global requires preferences with explicit global evidence; project-limited preferences stay current_project, which requires the registered task project. Ask when scope is uncertain. All routed proposals remain pending; saved IDs open existing human confirmation.' }),
      agentMemory: objectSchema({
        expectedRevision: integerSchema({ minimum: 0 }),
        memory: workingMemorySchema
      }, ['expectedRevision', 'memory']),
      collaborators: arraySchema(boundedString(128), { maxItems: 16 }),
      ...checkpointCompactFields
    }, ['taskContextToken', 'disposition', 'reason'])
  },
  {
    name: 'verify_task_checkpoint',
    title: 'LIFECYCLE · Verify end-of-task review',
    description: 'Hook-facing read that returns a Claude Code Stop decision. It blocks stopping only when begin_task_context succeeded for the session and checkpoint_task_knowledge has not yet recorded capture_candidates or retain_nothing.',
    inputSchema: objectSchema({ sessionId: id }, ['sessionId'])
  },
  {
    name: 'get_collaboration_preferences',
    title: 'READ FIRST · Load task collaboration preferences',
    description: 'Without begin_task_context hook context, call this exact tool name at the start of every user task, before any other tool or answer; never substitute a project action. Skip when the entry hook supplied preferences. Set projectPath=current working directory and taskPrompt=current user request. Use the actual native sessionId only when supplied by the host or this turn’s Hook; never guess or use an MCP process ID. With sessionId and taskPrompt, creates a fresh durable task and taskContextToken for checkpoint_task_knowledge with truthful workLog; never treats a pending task as Hook-delivery proof. Without native sessionId or prompt, task_lifecycle=not_started: preferences remain available, checkpoint ownership unverified. Never reuse old tokens. Blocked transcript handoff stays unverified even after successful fallback checkpoint. Fuli uses projectPath/taskPrompt transiently, never stores or returns them; resolves one exact registered local project; performs bounded automatic recall only for requests signaling stable prior context. Inspect task_knowledge_recall before reasking a project fact or method. On miss, call search_current_project_knowledge with 1–4 focused action, artifact, target-system, or identifier queries; never use the full conversational request as the only query. Resolve only relevant deferred_conflicts first; apply effective_preferences before answers or tool arguments. For write tools, enforce preferences in the actual payload; the final answer is not compliance. Personal-global preferences always apply; conflicted, pending, invalid, ambiguous-project, unrelated-project items never auto-apply. Automatic injection is not usage evidence. personalProjectId is an explicit compatibility override. Before substantial implementation, use plan_agent_collaboration and follow divisionPlan with bounded worker briefs; small edits/command-only checks need no artificial split. Include returned agent_receipt.markdown unchanged exactly once in every final reply, including greetings/capture-disabled tasks; never reuse an earlier owner.',
    inputSchema: objectSchema({
      sessionId: id,
      projectPath: boundedString(4096),
      taskPrompt: boundedString(8192),
      personalProjectId: nullableStringSchema(),
      projectAgentId: nullableStringSchema(),
      workKind: boundedString(128),
      workflow: boundedString(128),
      requiredCapabilities: arraySchema(boundedString(512), { maxItems: 16 }),
      limit: integerSchema({ minimum: 1, maximum: 200 })
    }, ['projectPath'])
  },
  {
    name: 'get_user_taste_skill',
    title: 'READ · Generate the current user-taste Skill',
    description: 'Generate a bounded read-only user-taste Skill projection from effective personal preferences for the exact active project. Prior confirmed and explicitly agent-confirmed preferences inform task-specific recommendations, labeled with evidence status and scope. Preserves current-request and authoritative-constraint precedence; never overwrites user-authored taste Skills or promotes pending inferences. Call when UI, writing, product, architecture, code, or other judgment benefits from established user taste.',
    inputSchema: objectSchema({
      projectPath: boundedString(4096),
      taskPrompt: boundedString(8192),
      personalProjectId: nullableStringSchema(),
      limit: integerSchema({ minimum: 1, maximum: 200 })
    }, ['projectPath'])
  },
  {
    name: 'resolve_deferred_preference_conflict',
    description: 'Resolve one AI-deferred conflict from get_collaboration_preferences only when the current task needs that preference. Compare both confirmed sides with their evidence and current context before choosing. Updates effective knowledge, preserves revision history, and permanently marks prior conflict as resolved by AI. Use merge with canonical item and merged instruction, keep_left/keep_right to retain one side, or split_scope to move one side to an exact personal project.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      conflictId: boundedString(1024),
      resolution: enumSchema([
        'merge', 'keep_left', 'keep_right', 'split_scope'
      ]),
      reason: shortText,
      canonicalItemId: nullableStringSchema(),
      mergedInstruction: nullableStringSchema(),
      splitItemId: nullableStringSchema(),
      splitProjectId: nullableStringSchema()
    }, ['personalSpaceId', 'conflictId', 'resolution', 'reason'])
  }
];
