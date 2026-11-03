// Deterministic replay of FULI context delivery (rec#15 PR3). It drives the
// real Claude Code and Codex UserPromptSubmit / reset hook entries with the
// real session delivery cache and native-evidence adapters, against synthetic
// transcripts and an in-memory Provider. Nothing here starts a client, calls a
// model, reads FULI data or a real transcript. It measures UTF-8 bytes only;
// it never estimates tokens. The reset hooks get no currentTask, so a
// SessionStart resume covers the next prompt after the reset, not the restored
// frame an active task would receive at once. Every entry carries a synthetic
// skeleton shaped like a real one (rec#76): receipt, rule references, the
// project Agent, the managers and the judgment policy. A notification turn runs
// the real in-place refresh with read_task_preferences.
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CLAUDE_REPLAYED_SOURCES, claudeLifecycleOutput } from '../../src/agents/claude-code/lifecycle-hook.js';
import { codexLifecycleOutput } from '../../src/agents/codex/lifecycle-hook.js';
import { codexPreferenceEvidence } from '../../src/agents/codex/preference-evidence.js';
import { claudePreferenceEvidence } from '../../src/agents/claude-code/preference-evidence.js';
import { createSessionPreferenceDelivery } from '../../src/conversations/preference-session.js';
import { withPreferenceScope } from '../../src/conversations/preference-snapshot.js';
import { beginConversation, resumeConversation } from '../../src/graphiti/agent-conversations.js';
import { createMcpServer } from '../../src/mcp/create-mcp-server.js';
import { projectAgentCollaborationPreferences } from '../../src/graphiti/collaboration-preference-workflow.js';
import { PROVIDER_RECOVERY_WINDOW, replayPreferences, syntheticHost, syntheticJournal } from '../../test-support/synthetic-context-session.js';
import { entryRules } from '../../src/conversations/entry-rules.js';
import { SKELETON_FIELDS, SKELETON_LABEL, SKELETON_UNCHANGED_LABEL } from '../../src/conversations/entry-skeleton.js';
import { canonicalJson } from '../../packages/roundtable/src/canonical-json.js';

const SPACE = 'synthetic-space';
const PROJECT = 'project';
const AGENT = 'lead';
// A prompt that names another FLA, and the folder of another project.
const OTHER_AGENT = 'reviewer';
const OTHER_PROJECT_FOLDER = 'other-project';
const HOOKS = { codex: codexLifecycleOutput, claude_code: claudeLifecycleOutput };
// The SessionStart sources after which the host replays the same transcript
// into the model's context, so the model keeps what it saw: Claude Code's
// resume (rec#11 D-69), the adapter's own list so the two cannot drift. Every
// other source starts a new model view.
const REPLAYED_SESSION_STARTS = { codex: [], claude_code: CLAUDE_REPLAYED_SOURCES };
const bytes = text => Buffer.byteLength(text, 'utf8');
const sha = text => createHash('sha256').update(text).digest('hex');
const frameOf = text => JSON.parse(text.split('\n').at(-1));
const READS = ['session', 'context', 'list', 'preferences'];

// The Provider's conversation journal and preference store, in memory. Every
// read is counted; both clients share it as they share the real Provider.
function syntheticProvider() {
  const conversations = new Map();
  const bindings = new Map();
  const calls = Object.fromEntries([...READS, 'append', 'resume'].map(name => [name, 0]));
  let activity = 0;
  const bind = (client, sessionId, id) => bindings.set(`${client}:${sessionId}`, id);
  const create = () => {
    const id = `conversation-${conversations.size + 1}`;
    conversations.set(id, { id, journal: syntheticJournal(id, PROVIDER_RECOVERY_WINDOW), window: {}, summary: null, activity: 0 });
    return conversations.get(id);
  };
  // A task entry's begin is one request; inside it the Provider makes the same
  // reads, counted as such, then the empty append (rec#11 D-53).
  const begin = async input => {
    const scope = { source_application: input.source_application, session_id: input.session_id };
    const { conversation_id: previousId } = await conversation('query', { ...scope, mode: 'session' });
    const previous = previousId ? await conversation('query', { ...scope, mode: 'context', conversation_id: previousId }) : null;
    const recent = previousId ? null : (await conversation('query', { mode: 'list', limit: 1 })).conversations[0] ?? null;
    return { ...await conversation('append', input), recovered_from: previousId, previous, recent };
  };
  const conversation = async (operation, input) => {
    if (operation === 'begin') return begin(input);
    if (operation === 'query') {
      calls[input.mode]++;
      if (input.mode === 'session') return { conversation_id: bindings.get(`${input.source_application}:${input.session_id}`) ?? null };
      if (input.mode === 'list') {
        const latest = [...conversations.values()].filter(item => item.journal.events.length)
          .sort((a, b) => b.activity - a.activity)[0];
        return { conversations: latest ? [{ id: latest.id, last_activity: `2026-10-23T00:00:${String(latest.activity).padStart(2, '0')}Z`,
          summary: latest.summary }] : [] };
      }
      const item = conversations.get(input.conversation_id);
      return { context: item.journal.recovery(input.source_application, input.session_id, item.window), compacted_through: 0 };
    }
    if (operation === 'resume') {
      calls.resume++;
      bind(input.source_application, input.session_id, input.conversation_id);
      return { status: 'resumed', conversation_id: input.conversation_id };
    }
    calls.append++;
    const key = `${input.source_application}:${input.session_id}`;
    if (!bindings.has(key)) bindings.set(key, create().id);
    const item = conversations.get(bindings.get(key));
    return { status: 'saved', conversation_id: item.id, revision: item.journal.events.length };
  };
  return {
    calls, conversations, conversation,
    boundTo: (client, sessionId) => conversations.get(bindings.get(`${client}:${sessionId}`)) ?? null,
    touch: item => { item.activity = ++activity; }
  };
}

// One replay world: the Provider, the session delivery cache, and native
// sessions. `items` is the Provider's confirmed preference set right now;
// `fixture` the variant's synthetic preferences and messages (fixtures.js).
export async function replayWorld(fn, { items = [], fixture } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'fuli-context-replay-'));
  const provider = syntheticProvider();
  const hosts = new Map();
  const tasks = new Map();
  const world = { items, fixture, turns: [], checks: [], provider };
  const delivery = createSessionPreferenceDelivery({ directory: join(directory, 'cache'), locate: async (source, sessionId) => {
    const target = hosts.get(`${source}:${sessionId}`);
    return target && { path: target.path, adapter: source === 'codex' ? codexPreferenceEvidence : claudePreferenceEvidence };
  } });
  const app = { config: { personal: { spaceId: SPACE } }, getCapturePolicy: () => ({ enabled: true }),
    personal: { conversation: provider.conversation },
    taskContextRegistry: { context: async token => tasks.get(token) } };

  // The Provider's preferences filtered for the task's scene, as an entry or
  // a refresh reads them.
  const taskPreferences = task => {
    provider.calls.preferences++;
    const projection = projectAgentCollaborationPreferences({ personal_space_id: SPACE, personal_project_id: task.personalProjectId,
      project_agent_id: task.projectAgentId, effective_preferences: structuredClone(world.items), truncated: false,
      source_windows: { candidates_truncated: false, project_ancestors_truncated: false, queued_conflicts_truncated: false } },
    { personalProjectId: task.personalProjectId }, { projectAgentId: task.projectAgentId,
      taskScope: { sessionId: task.sessionId, workKind: task.workKind } });
    return { ...projection, taskContextToken: task.token, task_context_token: task.token, checkpoint_required: true,
      context: { personal_project_id: task.personalProjectId, project_agent_id: task.projectAgentId } };
  };
  const scoped = (task, value) => withPreferenceScope(value, { personal_space_id: SPACE, personal_project_id: task.personalProjectId,
    project_agent_id: task.projectAgentId, session_id: task.sessionId, source_application: task.sourceApplication,
    preference_scope: { version: 1, work_kind: task.workKind, workflow: null } });

  // begin_task_context as the hooks invoke it: the conversation entry, then
  // the Provider's preferences filtered for the persisted scene.
  const beginTask = async args => {
    const token = `task-${String(tasks.size + 1).padStart(4, '0')}`;
    const task = { token, sessionId: args.sessionId, sourceApplication: args.sourceApplication, workKind: args.workKind ?? null,
      projectAgentId: args.taskPrompt?.startsWith(`#FLA ${OTHER_AGENT}`) ? OTHER_AGENT : AGENT,
      personalProjectId: args.projectPath?.endsWith(OTHER_PROJECT_FOLDER) ? `${PROJECT}-b` : PROJECT };
    tasks.set(token, task);
    const conversation = await beginConversation(app, task);
    return scoped(task, { ...taskPreferences(task), ...syntheticSkeleton(task, 'task_entry', world.recall), conversation });
  };
  // read_task_preferences for an in-place refresh: the same task, its role
  // replayed without the entry's memory, team and managers.
  const readTask = token => {
    const task = tasks.get(token);
    return scoped(task, { ...taskPreferences(task), ...syntheticSkeleton(task, 'preference_recovery'),
      preference_delivery: { status: 'complete' }, preferences_complete: true, same_task_recovery_available: true, truncated: false });
  };
  const currentTask = async (sessionId, sourceApplication) => [...tasks.values()]
    .findLast(task => task.sessionId === sessionId && task.sourceApplication === sourceApplication) ?? null;

  const open = async (client, label) => {
    const sessionId = randomUUID();
    const host = syntheticHost(directory, client, sessionId);
    hosts.set(`${client}:${sessionId}`, host);
    await host.start();
    const session = { client, label, host, sessionId, generation: 0, token: null };
    const model = () => ({ messages: new Map(), views: new Map(), preferences: new Map(), sent: new Set(), turns: 0, unlocated: false,
      skeletons: new Map(), skeleton: {}, skeletonUnlocated: false });
    let view = model();
    const input = extra => ({ session_id: sessionId, transcript_path: host.path, cwd: directory, ...extra });
    const projectFolder = { this: directory, other: join(directory, OTHER_PROJECT_FOLDER) };
    const resetHook = (event, extra = {}) => HOOKS[client](event, input(extra), async () => ({}), { delivery });

    // The person or the model says something natively; the transcript
    // collector stores it under the session's bound conversation.
    session.say = async (role, text) => {
      const eventId = await host.say(role, text);
      const bound = provider.boundTo(client, sessionId);
      if (!bound) return;
      bound.journal.add(role, text, client, sessionId, eventId);
      bound.summary = text;
      provider.touch(bound);
      view.messages.set(`${bound.id}:${bound.journal.events.length}`, text);
    };
    session.compact = async () => {
      await resetHook('PreCompact');
      await host.compact();
      view = model();
      session.generation++;
    };
    session.sessionStart = async source => {
      await resetHook('SessionStart', { source });
      if (REPLAYED_SESSION_STARTS[client].includes(source)) return;
      view = model();
      session.generation++;
    };
    // Exercise the real MCP result path and record what the native host exposes.
    session.resume = async (conversationId, { record = true, preview = false } = {}) => {
      const server = createMcpServer({ ...app, preferenceDelivery: delivery,
        resumeAgentConversation: args => resumeConversation(app, args) }, {
        env: {}, sourceApplication: client, registerResources: false, toolProfile: 'chat',
        nativeRequestContext: () => ({ nativeSessionId: sessionId, nativeExecutionId: 'synthetic', contextWindowId: `window-${session.generation}` })
      });
      let result;
      try {
        result = await server.server._requestHandlers.get('tools/call')({ method: 'tools/call', params: {
          name: 'fuli_call', arguments: { toolName: 'resume_agent_conversation', input: { taskContextToken: session.token, conversationId } }
        } }, { signal: new AbortController().signal, requestId: 1 });
      } finally { await server.close(); }
      if (result.isError) throw new Error(JSON.stringify(result.structuredContent));
      const visible = JSON.parse(result.content[0].text);
      if (record) {
        await host.toolResult(`resume-${session.token}`, result.structuredContent,
          preview ? { preview: 'Incomplete result' } : visible, 'mcp__fuli__fuli_call', { toolName: 'resume_agent_conversation' });
        if (!preview) for (const message of visible.context?.messages ?? []) {
          view.messages.set(`${visible.context.conversation_id}:${message.sequence}`, message.content);
        }
      }
      return visible;
    };

    // One prompt through the real hook entry. `record: false` loses the
    // output before the host records it; `preview` records only a head/tail
    // preview, as a host does with an oversized hook output.
    // `project: 'other'` runs the prompt in another project's folder. A
    // prompt that is one host-notification envelope is refreshed in place by
    // the hook: the same task re-read with read_task_preferences, never a new one.
    session.turn = async (prompt, { record = true, preview = false, note = '', project = 'this' } = {}) => {
      const before = { ...provider.calls };
      let context, scene;
      const invoke = async (name, args) => {
        if (name === 'read_task_preferences') {
          context = readTask(args.taskContextToken);
          scene = tasks.get(args.taskContextToken).workKind;
          return context;
        }
        if (name !== 'begin_task_context') throw new Error(`Unexpected tool ${name}`);
        scene = args.workKind ?? null;
        context = await beginTask(args);
        session.token = context.taskContextToken;
        return context;
      };
      const prompted = input({ prompt, cwd: projectFolder[project] });
      const text = (await HOOKS[client]('UserPromptSubmit', prompted, invoke, { delivery, currentTask }))
        .hookSpecificOutput.additionalContext;
      const retrieval = Object.fromEntries(READS.map(name => [name, provider.calls[name] - before[name]]));
      // The same entry through the same hook with no session cache. It reuses
      // this turn's Provider snapshot: a fair serialization comparison, not an
      // independent second retrieval.
      const uncached = async entry => (await HOOKS[client]('UserPromptSubmit', prompted, async () => entry,
        { currentTask: async () => ({ ...tasks.get(entry.taskContextToken) }) })).hookSpecificOutput.additionalContext;
      const baseline = await uncached(structuredClone(context));
      // Diagnostic only (D-29.8): the same entry with no preference and no
      // message, uncached. The cache cannot remove these bytes.
      const skeleton = await uncached(skeletonEntry(context));
      const frame = frameOf(text);
      const delivered = record && !preview;
      // What the host recorded, and so what the model could see: nothing when
      // the output was lost, only the preview when it was spilled.
      const visible = !record ? '' : preview ? `${text.slice(0, 40)}\n…[preview]…\n${text.slice(-40)}` : text;
      if (record) await host.inject(visible);
      const turn = measure({ session, view, frame, text, visible, baseline, skeleton, retrieval, delivered, note, prompt,
        scene });
      if (delivered) applyFrame(view, frame, text);
      turn.correctness = delivered ? correctness(view, frameOf(baseline), world.withdrawn ?? {}, labelOf(baseline)) : null;
      // A delta or scene switch whose base the model cannot locate by the
      // delivery rules: it must call read_task_preferences (entry-rules.js).
      turn.rereads_required = delivered && view.unlocated ? 1 : 0;
      turn.no_cache_messages = recoveryOf(frameOf(baseline))?.messages?.length ?? 0;
      // The replayed model view and the message bodies sent and in the
      // uncached window, for scenario checks against their own expected
      // sets; kept out of the JSON result.
      Object.defineProperty(turn, 'modelPreferences', { value: new Map(view.preferences) });
      Object.defineProperty(turn, 'sentMessages', { value: (recoveryOf(frame)?.messages ?? []).map(message => message.content) });
      Object.defineProperty(turn, 'windowMessages', { value: (recoveryOf(frameOf(baseline))?.messages ?? [])
        .map(message => message.content) });
      view.turns++;
      world.turns.push(turn);
      return turn;
    };
    return session;
  };

  world.open = open;
  world.check = (name, pass) => world.checks.push({ name, pass: Boolean(pass) });
  try { await fn(world); } finally { await rm(directory, { recursive: true, force: true }); }
  return { turns: world.turns, checks: world.checks, retrieval: Object.fromEntries(READS.map(name => [name, provider.calls[name]])) };
}

const recoveryOf = frame => frame.conversation?.recovery ?? null;
const messageKey = (recovery, message) => `${recovery.conversation_id}:${message.sequence}`;
const preferenceItems = frame => frame.effective_preferences ?? frame.preference_updates ?? [];

// Bucket, bytes and resends of one produced frame, before the model view
// takes it in. produced_bytes is the additionalContext the hook returned;
// host_visible_bytes is what the host recorded for the model (0 when lost,
// the preview when spilled). No other context cost is inferred.
function measure({ session, view, frame, text, visible, baseline, skeleton, retrieval, delivered, note, prompt, scene }) {
  const recovery = recoveryOf(frame);
  const omitted = recovery?.messages_omitted ?? 0;
  const bucket = frame.preference_delivery || omitted > 0 ? 'incremental'
    : view.turns === 0 ? 'first_or_reset_full' : 'changed_full';
  // A resend carries an item this generation was already sent; `seen` ones
  // the model provably already held.
  const items = [...(recovery?.messages ?? []).map(message => [`m:${messageKey(recovery, message)}:${sha(message.content)}`,
    view.messages.get(messageKey(recovery, message)) === message.content]),
  ...preferenceItems(frame).map(item => [`p:${item.preference_key}:${sha(item.instruction)}`,
    view.preferences.get(item.preference_key) === item.instruction])];
  const resent = items.filter(([key]) => view.sent.has(key));
  for (const [key] of items) view.sent.add(key);
  const pointer = frame.conversation?.recent_conversation;
  return { session: session.label, client: session.client, generation: session.generation, note, scene,
    prompt, bucket, delivered, preference_delivery: frame.preference_delivery?.status ?? 'full',
    produced_bytes: bytes(text), host_visible_bytes: bytes(visible), no_cache_bytes: bytes(baseline), skeleton_bytes: bytes(skeleton),
    // The exact encoding a complete frame adds so a later frame can name it.
    revision_field_bytes: frame.revision ? bytes(`,"revision":${JSON.stringify(frame.revision)}`) : 0,
    skeleton_revision_field_bytes: frame.skeleton_revision
      ? bytes(`,"skeleton_revision":${JSON.stringify(frame.skeleton_revision)}`) : 0,
    skeleton_delivery: frame.skeleton_unchanged ? 'unchanged' : 'full',
    skeleton_fields_omitted: typeof frame.skeleton_unchanged === 'string' || Array.isArray(frame.skeleton_unchanged) ? 'all'
      : Object.values(frame.skeleton_unchanged ?? {}).flat().length,
    messages_sent: recovery?.messages?.length ?? 0, messages_omitted: omitted,
    withdrawn_sequences: recovery?.withdrawn?.sequences ?? [],
    preferences_sent: preferenceItems(frame).length,
    resent_items: resent.length, resent_seen_items: resent.filter(([, seen]) => seen).length,
    pointer_bytes: pointer ? bytes(JSON.stringify({ recent_conversation: pointer })) : null,
    retrieval_calls: Object.values(retrieval).reduce((sum, value) => sum + value, 0), retrieval };
}

// What the model holds once the host recorded the frame it was shown. A
// frame whose base the model cannot locate leaves it without preferences.
function applyFrame(view, frame, text) {
  applySkeleton(view, frame, text);
  const recovery = recoveryOf(frame);
  for (const sequence of recovery?.withdrawn?.sequences ?? []) view.messages.delete(`${recovery.conversation_id}:${sequence}`);
  for (const message of recovery?.messages ?? []) view.messages.set(messageKey(recovery, message), message.content);
  const held = replayPreferences(view.views, frame);
  view.unlocated = !held;
  view.preferences = held ?? new Map();
}

// The skeleton the model holds for this frame: its own fields and label, and
// each part it names as unchanged, taken from the earlier frame of this view
// with that skeleton_revision. A base the view never held, or one without
// that part, cannot be located.
function applySkeleton(view, frame, text) {
  const own = Object.fromEntries(SKELETON_FIELDS.filter(field => Object.hasOwn(frame, field)).map(field => [field, frame[field]]));
  const label = ownLabel(labelOf(text));
  if (label !== null) own[SKELETON_LABEL] = label;
  view.skeleton = { ...own };
  view.skeletonUnlocated = false;
  // Revisions alone: every part of those frames, later over earlier, under
  // this frame's own. A map: each named part from its frame.
  const unchanged = frame.skeleton_unchanged;
  if (typeof unchanged === 'string' || Array.isArray(unchanged)) {
    const bases = [unchanged].flat().map(revision => view.skeletons.get(revision));
    view.skeletonUnlocated = bases.some(base => !base);
    view.skeleton = Object.assign({}, ...bases.filter(Boolean), own);
  } else {
    for (const [revision, parts] of Object.entries(unchanged ?? {})) {
      const base = view.skeletons.get(revision);
      for (const part of parts) {
        if (base && Object.hasOwn(base, part)) view.skeleton[part] = base[part];
        else view.skeletonUnlocated = true;
      }
    }
  }
  // A revision stands for everything the frame gave, what it named included.
  if (frame.skeleton_revision) view.skeletons.set(frame.skeleton_revision, { ...view.skeleton });
}

// The instructions above a hook frame, and the hook's own part of them.
const labelOf = text => {
  const lines = text.split('\n');
  return lines.slice(0, lines.findIndex(line => line.startsWith('{'))).join('\n');
};
function ownLabel(label) {
  if (label === SKELETON_UNCHANGED_LABEL) return null;
  return label.endsWith(` ${SKELETON_UNCHANGED_LABEL}`) ? label.slice(0, -SKELETON_UNCHANGED_LABEL.length - 1) : label;
}

// A skeleton shaped like a real entry's (task-context-view.js, rec#76), all
// synthetic: the receipt, the project Agent with its role, brief, memory,
// team and folder, the managers and the judgment policy. A refresh replays
// the role without memory, team or managers, as read_task_preferences does.
// `recall` adds an unmatched recall block, as a real entry has (rec#76
// scenarios; the older ones keep their size envelope).
function syntheticSkeleton(task, wake, recall = false) {
  const rules = entryRules().sections;
  const agent = task.projectAgentId;
  const memory = scope => ({ scope, revision: 0, current: null,
    guidance: scope === 'private_agent_global' ? rules.global_memory_guidance : rules.memory_guidance });
  const roster = ['Synthetic Lead', 'Synthetic Coder', 'Synthetic Tester', 'Synthetic Reviewer', 'Synthetic Writer']
    .map((name, index) => ({ agent_id: `agent-${index}`, name, occupation: index ? 'engineering' : null }));
  const entry = wake === 'task_entry';
  const resolution = { status: 'matched', basis: entry ? 'git_worktree_origin' : 'owned_task_context',
    personal_project_id: task.personalProjectId };
  return {
    context: { personal_space_id: SPACE, personal_project_id: task.personalProjectId, project_agent_id: agent,
      global_preference_count: 2, project_preference_count: 1, project_resolution: resolution, task_scope_excluded_count: 1,
      task_scope_filter: 'provider_before_conflicts', ...(entry ? {} : { session_id: task.sessionId,
        source_application: task.sourceApplication, source_session_id: task.sessionId,
        preference_scope: { version: 1, work_kind: task.workKind } }) },
    ...(entry && recall ? { task_knowledge_recall: { status: 'no_match', trigger_categories: ['release_delivery'], query_count: 2,
      noMatchSourceMarker: { required: true, label: 'FULI 来源', status: 'no_match', count: 0,
        leadMarkdown: '**[◇ FULI · 已检索，未命中](http://127.0.0.1:2828/)**', markdown: '' },
      facts: [], entities: [], guidance_ref: 'fuli://rules/task-entry/application_guidance' } } : {}),
    agent_receipt: { required: true, guidance: rules.receipt_guidance,
      markdown: `FULI Agent：[Synthetic ${agent} \\[${task.personalProjectId} 负责人\\]](<fuli://agents/${SPACE}/${agent}>)` },
    task_guidance: structuredClone(rules.task_guidance),
    project_agent_context: { status: 'ready', project_agent_id: agent, personal_project_id: task.personalProjectId,
      source_application: task.sourceApplication, wake_mode: wake, worker_started: false, selection_reason: 'project_team_lead',
      role: { name: `Synthetic ${agent}`, responsibility: '负责合成项目的开发、修复、测试与交付，并延续项目上下文。',
        initial_preferences: ['先理解现有实现与约定，再修改。', '结论附带可复现的验证证据。'] },
      project_brief: { name: `Synthetic ${task.personalProjectId}`, summary: 'AI draft (editable): synthetic project brief',
        authors: { purpose: 'agent 50% AI 草稿，可改' } },
      ...(entry ? { memory: memory('private_agent_project'), global_memory: memory('private_agent_global'),
        team: { roster, guidance: rules.team_guidance },
        directorySnapshot: { status: 'current', path: `agents/${'a'.repeat(32)}/${'b'.repeat(32)}/${'c'.repeat(32)}`,
          files: ['AGENTS.md', 'MEMORY.md', 'TEAM.md'].map(path => ({ path, state: 'unchanged' })) } } : {}),
      guidance: rules.continuity_guidance },
    ...(entry ? { project_management_context: { status: 'ready', managers: [{ template_id: 'synthetic-manager',
      agent_id: 'employee.synthetic-manager', name: 'Synthetic Manager', personal_project_id: task.personalProjectId,
      scope_mode: 'all', title_mode: 'auto', title_style: 'emoji', board: { version: 0, total: 0 },
      session: { sourceApplication: task.sourceApplication, sessionId: task.sessionId },
      tools: { discover: 'list_employee_tools', call: 'call_employee_tool', read_board: 'read_board', prepare_title: 'prepare_session_title' },
      guidance: rules.manager_guidance }] } } : {}),
    judgment_context: { agentId: 'employee.synthetic-judge', policy: { mode: 'autonomous', quality: 'quality',
      client: task.sourceApplication, revision: 0, globalRevision: 5, inherited: true, personalProjectId: task.personalProjectId },
    guidance: rules.judgment_guidance }
  };
}

// The same entry without any preference or message: what every turn costs.
function skeletonEntry(context) {
  const entry = structuredClone(context);
  entry.effective_preferences = [];
  if (entry.conversation?.recovery) entry.conversation.recovery.messages = [];
  return entry;
}

// The model view against the same entry without a cache: every current
// message and preference present, nothing stale, nothing withdrawn, and the
// base of every delta or scene switch located.
function correctness(view, expected, withdrawn, label) {
  const recovery = recoveryOf(expected);
  const messages = recovery?.messages ?? [];
  const missingMessages = messages.filter(message => view.messages.get(messageKey(recovery, message)) !== message.content)
    .map(message => message.sequence);
  const wanted = new Map((expected.effective_preferences ?? []).map(item => [item.preference_key, item.instruction]));
  const missingPreferences = [...wanted].filter(([key, value]) => view.preferences.get(key) !== value).map(([key]) => key);
  const extraPreferences = [...view.preferences.keys()].filter(key => !wanted.has(key));
  const withdrawnPresent = [
    ...(withdrawn.preferences ?? []).filter(key => view.preferences.has(key)).map(key => `preference:${key}`),
    ...(withdrawn.messages ?? []).filter(content => [...view.messages.values()].includes(content)).map(content => `message:${content.slice(0, 32)}`)
  ];
  // Every skeleton field of the uncached entry, exactly, and no other.
  const skeleton = SKELETON_FIELDS.filter(field => Object.hasOwn(expected, field) !== Object.hasOwn(view.skeleton, field)
    || (Object.hasOwn(expected, field) && canonicalJson(expected[field]) !== canonicalJson(view.skeleton[field])));
  if (view.skeleton[SKELETON_LABEL] !== label) skeleton.push(SKELETON_LABEL);
  const ok = !view.unlocated && !view.skeletonUnlocated && !missingMessages.length && !missingPreferences.length
    && !extraPreferences.length && !withdrawnPresent.length && !skeleton.length;
  return { ok, base_unlocated: view.unlocated, skeleton_unlocated: view.skeletonUnlocated, skeleton_mismatch: skeleton,
    missing_messages: missingMessages, missing_preferences: missingPreferences,
    extra_preferences: extraPreferences, withdrawn_present: withdrawnPresent };
}
