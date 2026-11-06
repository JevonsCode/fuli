import { contentHash } from '../../packages/roundtable/src/canonical-json.js';
import { latestPlan } from '../graphiti/project-agent-task-sheets.js';

// Repeated fixed steps become a tool (rec#78, 11-06 addition 3). When one FLA
// does the very same steps across several finished tasks, it is not written
// into a prompt again: the person is asked (待决策) whether that FLA should
// build a script or an Agent App for it. Model-free and conservative: the
// whole sequence must match exactly, step for step, in three tasks or more,
// or an active workflow must have run done at one version in three tasks.
// Each sequence is asked about once (the request's idempotency key); nothing
// is built here, and nothing is built without the person's yes.
const MIN_TASKS = 3;
const MIN_STEPS = 3;
const TASK_PAGE = 100;
const SHOWN_STEPS = 8;
const TOOL_CHOICES = Object.freeze(['做成脚本', '做成 Agent App', '不用']);

const normalized = title => String(title ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

// One FLA's plan steps per finished task, grouped by the exact sequence.
function repeatedPlans(tasks) {
  const groups = new Map();
  for (const task of tasks) {
    if (task.status !== 'completed' || !task.personalProjectId) continue;
    const byAgent = new Map();
    for (const step of latestPlan(task.events)?.steps ?? []) {
      if (step.status === 'skipped') continue;
      const agentId = step.agentId ?? task.leadAgentId;
      if (agentId) byAgent.set(agentId, [...(byAgent.get(agentId) ?? []), step.title]);
    }
    for (const [agentId, steps] of byAgent) {
      if (steps.length < MIN_STEPS) continue;
      const key = contentHash({ agentId, personalProjectId: task.personalProjectId, steps: steps.map(normalized) });
      const group = groups.get(key) ?? { key, agentId, personalProjectId: task.personalProjectId, steps, tasks: [] };
      if (!group.tasks.some(seen => seen.taskId === task.taskId)) group.tasks.push({ taskId: task.taskId, title: task.title });
      groups.set(key, group);
    }
  }
  return [...groups.values()].filter(group => group.tasks.length >= MIN_TASKS);
}

// An active workflow its FLA ran done at the same version in enough tasks.
function repeatedWorkflows(workflows) {
  const found = [];
  for (const { personalSpaceId, agentId, workflow } of workflows) {
    if (workflow.status !== 'active' || !workflow.active || !workflow.personalProjectId) continue;
    const done = new Set(workflow.recentRuns.filter(run => run.outcome === 'done' && run.taskId
      && run.version === workflow.active.version).map(run => run.taskId));
    if (done.size < MIN_TASKS) continue;
    found.push({ key: contentHash({ workflowId: workflow.workflowId, version: workflow.active.version }), personalSpaceId, agentId,
      personalProjectId: workflow.personalProjectId, steps: workflow.active.steps.map(step => step.title),
      tasks: [...done].map(taskId => ({ taskId, title: null })), workflowName: workflow.active.name });
  }
  return found;
}

async function suggestRepeatedTools(app) {
  const personalSpaceId = app.config.personal.spaceId;
  const tasks = await app.listProjectAgentTasks({ personalSpaceId, status: 'completed', limit: TASK_PAGE });
  const workflows = [];
  for (const row of app.agentWorkflows?.listSpace({ personalSpaceId }) ?? []) {
    if (row.status !== 'active') continue;
    const overview = app.agentWorkflows.overview({ personalSpaceId, agentId: row.agentId });
    const workflow = overview.workflows.find(entry => entry.workflowId === row.workflowId);
    if (workflow) workflows.push({ personalSpaceId, agentId: row.agentId, workflow });
  }
  const asked = [];
  for (const repeat of [...repeatedPlans(tasks), ...repeatedWorkflows(workflows)]) {
    // One that cannot be asked now (its FLA left the project, say) keeps the others going.
    try {
      await app.requestAgentAttention(attentionFor(personalSpaceId, repeat));
      asked.push({ agentId: repeat.agentId, personalProjectId: repeat.personalProjectId, tasks: repeat.tasks.length });
    } catch { /* asked again on a later tick */ }
  }
  return { asked };
}

// The same request every tick: it names the steps only, never a count or
// tasks that change as more are finished, so asking again is the same request.
function attentionFor(personalSpaceId, repeat) {
  const name = repeat.workflowName ?? repeat.steps[0];
  const steps = repeat.steps.slice(0, SHOWN_STEPS).map((title, index) => `${index + 1}. ${title}`);
  return { personalSpaceId, personalProjectId: repeat.personalProjectId, agentId: repeat.agentId,
    idempotencyKey: `tool-suggestion:${repeat.key}`, kind: 'approval',
    title: `「${name}」这串步骤已重复 ${MIN_TASKS} 次以上，要做成工具吗？`.slice(0, 160),
    detail: [`同样的 ${repeat.steps.length} 步，在 ${MIN_TASKS} 个以上任务里一模一样：`, ...steps,
      ...(repeat.steps.length > SHOWN_STEPS ? [`……共 ${repeat.steps.length} 步`] : [])].join('\n').slice(0, 4096),
    requestedAction: '选「做成脚本」或「做成 Agent App」，这个 FLA 才会去做；选「不用」就照旧。不经你同意什么都不做。',
    options: [...TOOL_CHOICES] };
}

// A tick on the console host only. Each sequence is asked once, so a tick
// repeats nothing; a failed tick is tried on the next.
export function startToolSuggestionScheduler({ app, withLease = (_owner, run) => run(), intervalMs = 3_600_000 }) {
  let running = false, active = null, stopped = false;
  const tick = async () => {
    if (stopped || running || app.getAgentAccessPolicy?.().enabled === false) return;
    running = true;
    try { await withLease('tool-suggestions', () => suggestRepeatedTools(app)); }
    catch { /* The next tick tries again. */ }
    finally { running = false; }
  };
  const timer = setInterval(() => { if (!running && !stopped) active = tick(); }, intervalMs);
  timer.unref?.();
  return async () => { stopped = true; clearInterval(timer); await active; };
}
