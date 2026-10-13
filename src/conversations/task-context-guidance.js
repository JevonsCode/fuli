// Static guidance prose repeats on every task entry while only the task data
// changes. This view separates the prose so a host adapter can deliver it on
// demand. Lifecycle-critical rules stay inline: the receipt obligation and the
// checkpoint contract must be visible on every turn.
const ON_DEMAND_GUIDANCE_PATHS = [
  ['application_guidance'],
  ['task_guidance', 'execution_plan'],
  ['task_guidance', 'collaboration'],
  ['task_guidance', 'profile_capture'],
  ['task_guidance', 'human_attention'],
  ['task_guidance', 'retrieval'],
  ['agent_receipt', 'continuation', 'guidance'],
  ['conversation', 'guidance'],
  ['conversation', 'recovery', 'guidance'],
  ['project_agent_context', 'guidance'],
  ['project_agent_context', 'team_guidance'],
  ['project_agent_context', 'details_guidance'],
  ['project_agent_context', 'memory', 'guidance'],
  ['project_agent_context', 'global_memory', 'guidance'],
  ['judgment_context', 'guidance']
];

export const GUIDANCE_READ_WHEN = 'Read this file before delegating or collaborating, publishing an execution plan, '
  + 'capturing profile preferences, requesting human attention, merging or checkpointing memory, resuming omitted '
  + 'history, or interpreting preference scope and inheritance. Inline rules and effective_preferences still apply.';

export function separateStaticGuidance(value) {
  if (!value || typeof value !== 'object') return { context: value, guidance: [] };
  const context = structuredClone(value);
  const guidance = [];
  for (const path of ON_DEMAND_GUIDANCE_PATHS) {
    const parent = path.slice(0, -1).reduce((node, key) => node?.[key], context);
    const key = path.at(-1);
    if (!parent || typeof parent !== 'object' || parent[key] === undefined) continue;
    guidance.push({ path: path.join('.'), value: parent[key] });
    delete parent[key];
  }
  // One token field is enough; both names carry the same value.
  if (context.task_context_token === context.taskContextToken) delete context.task_context_token;
  return { context, guidance };
}

export function renderGuidanceMarkdown(guidance) {
  const sections = guidance.map(({ path, value }) => `## ${path}\n\n${renderValue(value)}`);
  return `# FULI task guidance\n\nStatic rules for the current task context. ${GUIDANCE_READ_WHEN}\n\n${sections.join('\n\n')}\n`;
}

function renderValue(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value).map(([key, item]) => typeof item === 'string'
      ? `- **${key}**: ${item}`
      : `- **${key}**:\n${renderValue(item).split('\n').map((line) => `  ${line}`).join('\n')}`).join('\n');
  }
  return JSON.stringify(value);
}
