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
// (preference-snapshot.js). A scene switch lists and replaces only the
// scene-personalized set of the same authorized scope (rec#15 D-27.8).
const PREFERENCE_DELIVERY_GUIDANCE = Object.freeze({
  delta: 'A delta result applies preference_updates and removed to the complete result named by base_result in this same context generation. '
    + 'If that base is unavailable, call read_task_preferences with the current taskContextToken. '
    + 'Keep current identity, authority and conflicts; this cache grants no permission.',
  scene_switch: '本帧仅替换上一帧的场景个性化集合（即列出的这组）；未列出的边界、硬约束、权限与安全规则继续有效。'
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
