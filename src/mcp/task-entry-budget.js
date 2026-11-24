// get_collaboration_preferences for a client that reads FULI only through MCP
// tools (no prompt hook): the same bounded entry a hook frame gets, and no
// second copy of the preferences within one conversation. A hook bounds its
// own frame (preference-lifecycle.js) and never comes through here.
import { contentHash } from '../../packages/roundtable/src/canonical-json.js';
import { hardRulesOnly, inlineEntryFit, OMITTED_PREFERENCES_LABEL, omittedSentences } from '../conversations/entry-inline-budget.js';
import { entryPreferenceScene } from '../conversations/preference-snapshot.js';
import { entryRules } from '../conversations/entry-rules.js';
import { taskPreferenceRead } from './preference-delivery.js';

// The inline limit of an MCP task entry, in characters of the tool result's
// text. It is larger than a hook entry's 9,000: that one is forced by the
// 10,000-character preview Claude Code keeps of a hook context
// (agents/claude-code/lifecycle-event.js), and a tool result has no such cap.
// What it must hold is a line with a gist for every preference it does not
// spell out (preferences_omitted.index), so the model can name the ones this
// task needs: a count alone leaves it reading all of them or none. A real-scale
// working entry (syntheticWorkingEntry: 70 preferences, 8 hard rules, a role
// with both memory layers, a team and a manager) first carries that index at
// 17,000 (its answer 16,996 characters: 8 hard rules, 62 lines of about 4.9k);
// this is that plus about 10%. An entry of preferences alone gives the room to
// more bodies (mcp-task-entry-budget.test.js).
export const MCP_ENTRY_INLINE_CHARS = 18700;

// The limit of an answer whose preferences are unchanged (knownRevision): it
// repeats only the hard rules and points back at the index, so it needs no
// room for one, and what the larger limit left free went to the role's memory,
// the recall and the conversation again (a real-scale working entry answered
// 15,472 characters where 8,868 did). A hook entry's limit holds it.
export const MCP_UNCHANGED_INLINE_CHARS = 9000;

// The revision's length, as a frame's own revision (preference-snapshot.js).
const REVISION_HEX = 12;

// The rest still apply: the next sentence (OMITTED_PREFERENCES_LABEL) says to
// read the ones that may. A client may compact its context without the server
// knowing, so the earlier answer may be gone: then it asks again.
export const UNCHANGED_LABEL = 'Preferences unchanged since knownRevision: only the hard rules are repeated; '
  + 'the rest and their index (index_unchanged) are as your earlier answer listed. If it is no longer in this '
  + 'conversation, call again without knownRevision or use preferences_omitted.read.';

// The bounded entry for one answer, or null where the answer stays whole: a
// result without a task token and Agent (its reader would refuse, rec#128) or
// a server that does not offer read_task_preferences (`readable` false, as
// the remote connector) could not reach what a bound leaves out.
// `knownRevision`: the preferences_revision of the caller's earlier answer in
// this conversation. Where it is this one, every preference but the hard
// rules is left out: the caller holds them (`unchanged`).
// `session`: the conversation the revision is bound to, so one named in
// another session or MCP process never matches.
export function mcpTaskEntry(view, { knownRevision = null, session = null, projectPath = null, readable = false } = {}) {
  if (!readable || !taskPreferenceRead(view) || !Array.isArray(view?.effective_preferences)) return null;
  const revision = preferencesRevision(view, session);
  const lean = knownRevision === revision ? hardRulesOnly(view) : view;
  const unchanged = lean !== view;
  return {
    value: unchanged ? { ...lean, preferences_omitted: { ...lean.preferences_omitted, unchanged: true, index_unchanged: true } }
      : view,
    unchanged,
    fit: inlineEntryFit(unchanged ? MCP_UNCHANGED_INLINE_CHARS : MCP_ENTRY_INLINE_CHARS, resultChars, { projectPath }),
    // What the answer adds to the frame the fit chose: the revision to name
    // next time, and what it leaves out in words (a hook says it in its label).
    notes: projected => withNotes(unchanged ? pointingBack(projected) : projected, revision)
  };
}

// The fit may rebuild what it leaves out: an unchanged answer says so on what
// the fit chose, and carries no index of its own (the earlier answer's stands).
function pointingBack(projected) {
  const { index: _index, index_added: _added, ...omitted } = projected.preferences_omitted ?? {};
  return { ...projected, preferences_omitted: { ...omitted, unchanged: true, index_unchanged: true } };
}

function withNotes(projected, revision) {
  const sentences = omittedSentences(projected);
  const guidance = projected?.preferences_omitted?.unchanged ? [UNCHANGED_LABEL, OMITTED_PREFERENCES_LABEL,
    ...(projected.active_conflicts_omitted ? sentences.slice(-1) : [])] : sentences;
  // next_call: what to pass back, beside the revision, for a model that does not read the tool's description.
  return { ...projected, preferences_revision: revision, next_call: `knownRevision=${revision}`,
    ...(guidance ? { omitted_guidance: guidance.join(' ') } : {}) };
}

// Everything a later answer would repeat if it changed: the preferences and
// conflicts as compacted, the project, Agent, session and task scene (work
// kind, workflow: they rank the preferences, as a hook frame's scopeHash
// holds them), and the entry rules they are read by.
function preferencesRevision(view, session) {
  const context = view.context ?? {};
  return contentHash(JSON.parse(JSON.stringify({ rules: entryRules().version, session,
    scope: [context.personal_space_id ?? null, context.personal_project_id ?? null, context.project_agent_id ?? null],
    scene: entryPreferenceScene(view),
    preferences: view.effective_preferences, active: view.active_conflicts ?? [], deferred: view.deferred_conflicts ?? [] })))
    .slice(0, REVISION_HEX);
}

function resultChars(result) {
  return result.content[0].text.length;
}
