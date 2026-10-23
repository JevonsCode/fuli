import { isDeepStrictEqual } from 'node:util';
import { contentHash } from '../../packages/roundtable/src/canonical-json.js';
import { STOP_HOOK_CHECKPOINT_GUIDANCE, taskKnowledgeGuidance } from '../graphiti/agent-knowledge-workflows.js';
import { GENERIC_SCOPE_GUIDANCE, STATIC_APPLICATION_GUIDANCE } from '../graphiti/collaboration-preference-workflow.js';
import { CONVERSATION_GUIDANCE } from '../graphiti/agent-conversations.js';
import { PROJECT_AGENT_CONTINUITY_GUIDANCE } from '../graphiti/project-agent-task-entry.js';
import { TEAM_GUIDANCE } from '../graphiti/project-agent-team-context.js';
import { CONTINUATION_GUIDANCE, RECEIPT_GUIDANCE } from '../agents/identity-receipt.js';

const MEMORY_GUIDANCE = 'Use get_project_agent_memory before merging or checkpointing working memory; this preview omits history and may truncate notes.';
export const DETAILS_GUIDANCE = 'Read get_project_team for staffing and list_project_agent_tasks for task history when needed.';
// How a session-delivered preference frame relates to the earlier one it names
// (preference-snapshot.js). A scene switch replaces only that revision's
// preferences in the same authorized scope (rec#15 D-27, dot contract item 2).
const PREFERENCE_DELIVERY_GUIDANCE = Object.freeze({
  delta: 'A delta result applies preference_updates and removed to the complete result named by base_result in this same context generation. '
    + 'If that base is unavailable, call read_task_preferences with the current taskContextToken. '
    + 'Keep current identity, authority and conflicts; this cache grants no permission.',
  scene_switch: 'A scene_switch result is the complete current effective_preferences for its preference_scene, even when the list is empty. '
    + 'It replaces only the preferences of the revision named by supersedes (base_result), with their updates, for this same space, project, Agent, client and session; '
    + 'a preference of that revision that is not listed here no longer applies. It does not change role configuration, permissions, safety rules, '
    + 'constraints from other sources, other projects or Agents, or any other FULI context.'
});
const GLOBAL_MEMORY_GUIDANCE = 'Global layer of the same employee. Read get_project_agent_memory with personalProjectId: null before merging or checkpointing it; this preview omits history and may truncate notes.';

// Task-independent rule text shared by every task entry. The hot path sends a
// versioned reference; the full text stays readable as one MCP resource.
export const ENTRY_RULES_URI = 'fuli://rules/task-entry';

let rules = null;

// Built on first use: the source modules import each other, so module
// evaluation order must not decide whether the text exists.
export function entryRules() {
  if (!rules) {
    const sections = { task_guidance: taskKnowledgeGuidance(),
      application_guidance: { ...STATIC_APPLICATION_GUIDANCE },
      conversation_guidance: CONVERSATION_GUIDANCE, continuity_guidance: PROJECT_AGENT_CONTINUITY_GUIDANCE,
      team_guidance: TEAM_GUIDANCE, memory_guidance: MEMORY_GUIDANCE,
      global_memory_guidance: GLOBAL_MEMORY_GUIDANCE, continuation_guidance: CONTINUATION_GUIDANCE,
      scope_guidance: { ...GENERIC_SCOPE_GUIDANCE }, receipt_guidance: RECEIPT_GUIDANCE,
      details_guidance: DETAILS_GUIDANCE, checkpoint_guidance: STOP_HOOK_CHECKPOINT_GUIDANCE,
      preference_delivery: { ...PREFERENCE_DELIVERY_GUIDANCE } };
    rules = Object.freeze({ sections, version: contentHash(sections).slice(0, 12) });
  }
  return rules;
}

export function entryRulesReference(section) {
  return { rules: `${ENTRY_RULES_URI}#${section}`, version: entryRules().version };
}

// True only when every static key is present with exactly the shared text.
export function containsEntryRules(value, section) {
  const expected = entryRules().sections[section];
  return Boolean(value) && Object.entries(expected).every(([key, text]) => isDeepStrictEqual(value[key], text));
}

// A shared sentence becomes its reference; any other text is kept as is.
export function ruleTextView(value, section) {
  return value === entryRules().sections[section] ? entryRulesReference(section) : value;
}

export function entryRulesMarkdown() {
  const { sections, version } = entryRules();
  const block = (title, entries) => [`## ${title}`, ...entries.map(([key, text]) =>
    `- **${key}**: ${typeof text === 'string' ? text : JSON.stringify(text)}`)];
  return [`# FULI task entry rules (version ${version})`, '',
    'Task entries reference these sections instead of repeating them each turn.', '',
    ...Object.entries(sections).flatMap(([title, value]) => typeof value === 'string'
      ? [`## ${title}`, value, ''] : [...block(title, Object.entries(value)), ''])].join('\n');
}
