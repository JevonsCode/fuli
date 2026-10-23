// Deterministic replay of FULI context delivery (rec#15 PR3). It drives the
// real Claude Code and Codex UserPromptSubmit / reset hook entries with the
// real session delivery cache and native-evidence adapters, against synthetic
// transcripts and an in-memory Provider. Nothing here starts a client, calls a
// model, reads FULI data or a real transcript. It measures UTF-8 bytes only;
// it never estimates tokens. The reset hooks get no currentTask, so a
// SessionStart resume covers the next prompt after the reset, not the restored
// frame an active task would receive at once.
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { claudeLifecycleOutput } from '../../src/agents/claude-code/lifecycle-hook.js';
import { codexLifecycleOutput } from '../../src/agents/codex/lifecycle-hook.js';
import { codexPreferenceEvidence } from '../../src/agents/codex/preference-evidence.js';
import { claudePreferenceEvidence } from '../../src/agents/claude-code/preference-evidence.js';
import { createSessionPreferenceDelivery } from '../../src/conversations/preference-session.js';
import { withPreferenceScope } from '../../src/conversations/preference-snapshot.js';
import { beginConversation, resumeConversation } from '../../src/graphiti/agent-conversations.js';
import { projectAgentCollaborationPreferences } from '../../src/graphiti/collaboration-preference-workflow.js';
import { replayPreferences, syntheticHost, syntheticJournal } from '../../test-support/synthetic-context-session.js';

const SPACE = 'synthetic-space';
const PROJECT = 'project';
const AGENT = 'lead';
const HOOKS = { codex: codexLifecycleOutput, claude_code: claudeLifecycleOutput };
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
    conversations.set(id, { id, journal: syntheticJournal(id), window: {}, summary: null, activity: 0 });
    return conversations.get(id);
  };
  const conversation = async (operation, input) => {
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
// sessions. `items` is the Provider's confirmed preference set right now.
export async function replayWorld(fn, { items = [] } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'fuli-context-replay-'));
  const provider = syntheticProvider();
  const hosts = new Map();
  const tasks = new Map();
  const world = { items, turns: [], checks: [], provider };
  const delivery = createSessionPreferenceDelivery({ directory: join(directory, 'cache'), locate: async (source, sessionId) => {
    const target = hosts.get(`${source}:${sessionId}`);
    return target && { path: target.path, adapter: source === 'codex' ? codexPreferenceEvidence : claudePreferenceEvidence };
  } });
  const app = { config: { personal: { spaceId: SPACE } }, getCapturePolicy: () => ({ enabled: true }),
    personal: { conversation: provider.conversation },
    taskContextRegistry: { context: async token => tasks.get(token) } };

  // begin_task_context as the hooks invoke it: the conversation entry, then
  // the Provider's preferences filtered for the persisted scene.
  const beginTask = async args => {
    const token = `task-${String(tasks.size + 1).padStart(4, '0')}`;
    const task = { token, projectAgentId: AGENT, personalProjectId: PROJECT, sessionId: args.sessionId,
      sourceApplication: args.sourceApplication };
    tasks.set(token, task);
    const conversation = await beginConversation(app, task);
    provider.calls.preferences++;
    const workKind = args.workKind ?? null;
    const projection = projectAgentCollaborationPreferences({ personal_space_id: SPACE, personal_project_id: PROJECT,
      project_agent_id: AGENT, effective_preferences: structuredClone(world.items), truncated: false,
      source_windows: { candidates_truncated: false, project_ancestors_truncated: false, queued_conflicts_truncated: false } },
    { personalProjectId: PROJECT }, { projectAgentId: AGENT, taskScope: { sessionId: args.sessionId, workKind } });
    return withPreferenceScope({ ...projection, taskContextToken: token, task_context_token: token, checkpoint_required: true,
      context: { personal_project_id: PROJECT, project_agent_id: AGENT }, conversation },
    { personal_space_id: SPACE, personal_project_id: PROJECT, project_agent_id: AGENT, session_id: args.sessionId,
      source_application: args.sourceApplication, preference_scope: { version: 1, work_kind: workKind, workflow: null } });
  };

  const open = async (client, label) => {
    const sessionId = randomUUID();
    const host = syntheticHost(directory, client, sessionId);
    hosts.set(`${client}:${sessionId}`, host);
    await host.start();
    const session = { client, label, host, sessionId, generation: 0, token: null };
    const model = () => ({ messages: new Map(), views: new Map(), preferences: new Map(), sent: new Set(), turns: 0 });
    let view = model();
    const input = extra => ({ session_id: sessionId, transcript_path: host.path, cwd: directory, ...extra });
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
      view = model();
      session.generation++;
    };
    // The explicit resume_agent_conversation tool call (D-27.6).
    session.resume = async conversationId => {
      await resumeConversation(app, { taskContextToken: session.token, sourceApplication: client, conversationId });
    };

    // One prompt through the real hook entry. `record: false` loses the
    // output before the host records it; `preview` records only a head/tail
    // preview, as a host does with an oversized hook output.
    session.turn = async (prompt, { record = true, preview = false, note = '' } = {}) => {
      const before = { ...provider.calls };
      let context;
      const invoke = async (name, args) => {
        if (name !== 'begin_task_context') throw new Error(`Unexpected tool ${name}`);
        context = await beginTask(args);
        session.token = context.taskContextToken;
        return context;
      };
      const text = (await HOOKS[client]('UserPromptSubmit', input({ prompt }), invoke, { delivery }))
        .hookSpecificOutput.additionalContext;
      const retrieval = Object.fromEntries(READS.map(name => [name, provider.calls[name] - before[name]]));
      // The same entry through the same hook with no session cache. It reuses
      // this turn's Provider snapshot: a fair serialization comparison, not an
      // independent second retrieval.
      const baseline = (await HOOKS[client]('UserPromptSubmit', input({ prompt }), async () => structuredClone(context), {}))
        .hookSpecificOutput.additionalContext;
      const frame = frameOf(text);
      const delivered = record && !preview;
      // What the host recorded, and so what the model could see: nothing when
      // the output was lost, only the preview when it was spilled.
      const visible = !record ? '' : preview ? `${text.slice(0, 40)}\n…[preview]…\n${text.slice(-40)}` : text;
      const recordOffset = record ? await host.inject(visible) : null;
      const turn = measure({ session, view, frame, text, visible, baseline, retrieval, delivered, note, prompt });
      if (delivered) applyFrame(view, frame, client === 'claude_code' ? `attachment-${recordOffset}` : `codex-${world.turns.length}`);
      turn.correctness = delivered ? correctness(view, frameOf(baseline), world.withdrawn ?? {}) : null;
      // The replayed model view, for scenario checks against their own
      // expected sets; kept out of the JSON result.
      Object.defineProperty(turn, 'modelPreferences', { value: new Map(view.preferences) });
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
function measure({ session, view, frame, text, visible, baseline, retrieval, delivered, note, prompt }) {
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
  return { session: session.label, client: session.client, generation: session.generation, note, scene: frame.preference_scene?.work_kind ?? null,
    prompt, bucket, delivered, preference_delivery: frame.preference_delivery?.status ?? 'full',
    produced_bytes: bytes(text), host_visible_bytes: bytes(visible), no_cache_bytes: bytes(baseline),
    messages_sent: recovery?.messages?.length ?? 0, messages_omitted: omitted,
    withdrawn_sequences: recovery?.withdrawn?.sequences ?? [],
    preferences_sent: preferenceItems(frame).length,
    resent_items: resent.length, resent_seen_items: resent.filter(([, seen]) => seen).length,
    pointer_bytes: pointer ? bytes(JSON.stringify({ recent_conversation: pointer })) : null,
    retrieval_calls: Object.values(retrieval).reduce((sum, value) => sum + value, 0), retrieval };
}

// What the model holds once the host recorded the frame it was shown.
function applyFrame(view, frame, id) {
  const recovery = recoveryOf(frame);
  for (const sequence of recovery?.withdrawn?.sequences ?? []) view.messages.delete(`${recovery.conversation_id}:${sequence}`);
  for (const message of recovery?.messages ?? []) view.messages.set(messageKey(recovery, message), message.content);
  view.preferences = replayPreferences(view.views, { id, frame });
}

// The model view against the same entry without a cache: every current
// message and preference present, nothing stale, nothing withdrawn.
function correctness(view, expected, withdrawn) {
  const recovery = recoveryOf(expected);
  const messages = recovery?.messages ?? [];
  const missingMessages = messages.filter(message => view.messages.get(messageKey(recovery, message)) !== message.content)
    .map(message => message.sequence);
  const wanted = new Map((expected.effective_preferences ?? []).map(item => [item.preference_key, item.instruction]));
  const missingPreferences = [...wanted].filter(([key, value]) => view.preferences.get(key) !== value).map(([key]) => key);
  const extraPreferences = [...view.preferences.keys()].filter(key => !wanted.has(key));
  const withdrawnPresent = [
    ...(withdrawn.preferences ?? []).filter(key => view.preferences.has(key)).map(key => `preference:${key}`),
    ...(withdrawn.messages ?? []).filter(content => [...view.messages.values()].includes(content)).map(content => `message:${content}`)
  ];
  return { ok: !missingMessages.length && !missingPreferences.length && !extraPreferences.length && !withdrawnPresent.length,
    missing_messages: missingMessages, missing_preferences: missingPreferences, extra_preferences: extraPreferences,
    withdrawn_present: withdrawnPresent };
}
