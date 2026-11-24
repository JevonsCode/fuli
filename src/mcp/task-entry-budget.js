// get_collaboration_preferences for a client that reads FULI only through MCP
// tools (no prompt hook): the same bounded entry a hook frame gets, and no
// second copy of the preferences within one conversation. A hook bounds its
// own frame (preference-lifecycle.js) and never comes through here.
import { contentHash } from '../../packages/roundtable/src/canonical-json.js';
import { hardRulesOnly, inlineEntryFit, omittedSentences } from '../conversations/entry-inline-budget.js';
import { entryRules } from '../conversations/entry-rules.js';
import { taskPreferenceRead } from './preference-delivery.js';

// The inline limit of an MCP task entry, in characters of the tool result's
// text. A tool result has no host preview cap like the 10,000 characters a
// Claude Code hook context keeps (agents/claude-code/lifecycle-event.js, 9,000
// of them for the entry), so this is FULI's own choice: the same size, which
// holds an entry's own fields (about 3.5k, token-budget.test.js) beside the
// hard rules, the best-ranked preferences and a line for each of the rest of a
// real working set (70 preferences, 8 hard rules), as hook entries have since
// rec#11 D-54. Everything else stays one read_task_preferences away.
export const MCP_ENTRY_INLINE_CHARS = 9000;

// The revision's length, as a frame's own revision (preference-snapshot.js).
const REVISION_HEX = 12;

export const UNCHANGED_LABEL = 'Preferences unchanged since knownRevision: keep applying what your earlier answer listed; '
  + 'only the hard rules are repeated. If that answer is no longer in this conversation, read the rest with '
  + 'preferences_omitted.read before acting.';

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
    value: unchanged ? { ...lean, preferences_omitted: { ...lean.preferences_omitted, unchanged: true } } : view,
    unchanged,
    fit: inlineEntryFit(MCP_ENTRY_INLINE_CHARS, resultChars, { projectPath }),
    // What the answer adds to the frame the fit chose: the revision to name
    // next time, and what it leaves out in words (a hook says it in its label).
    notes: projected => withNotes(projected, revision)
  };
}

function withNotes(projected, revision) {
  const sentences = omittedSentences(projected);
  const guidance = projected?.preferences_omitted?.unchanged
    ? [UNCHANGED_LABEL, ...(projected.active_conflicts_omitted ? sentences.slice(-1) : [])] : sentences;
  return { ...projected, preferences_revision: revision, ...(guidance ? { omitted_guidance: guidance.join(' ') } : {}) };
}

// Everything a later answer would repeat if it changed: the preferences and
// conflicts as compacted, the project, Agent and session, and the entry rules
// they are read by.
function preferencesRevision(view, session) {
  const context = view.context ?? {};
  return contentHash(JSON.parse(JSON.stringify({ rules: entryRules().version, session,
    scope: [context.personal_space_id ?? null, context.personal_project_id ?? null, context.project_agent_id ?? null],
    preferences: view.effective_preferences, active: view.active_conflicts ?? [], deferred: view.deferred_conflicts ?? [] })))
    .slice(0, REVISION_HEX);
}

function resultChars(result) {
  return result.content[0].text.length;
}
