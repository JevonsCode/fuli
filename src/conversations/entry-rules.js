import { isDeepStrictEqual } from 'node:util';
import { contentHash } from '../publication/canonical-json.js';
import { taskKnowledgeGuidance } from '../graphiti/agent-knowledge-workflows.js';
import { STATIC_APPLICATION_GUIDANCE } from '../graphiti/collaboration-preference-workflow.js';
import { CONVERSATION_GUIDANCE } from '../graphiti/agent-conversations.js';
import { PROJECT_AGENT_CONTINUITY_GUIDANCE } from '../graphiti/project-agent-task-entry.js';
import { TEAM_GUIDANCE } from '../graphiti/project-agent-team-context.js';
import { CONTINUATION_GUIDANCE } from '../agents/identity-receipt.js';

const MEMORY_GUIDANCE = 'Use get_project_agent_memory before merging or checkpointing working memory; this preview omits history and may truncate notes.';
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
      global_memory_guidance: GLOBAL_MEMORY_GUIDANCE, continuation_guidance: CONTINUATION_GUIDANCE };
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
