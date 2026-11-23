import { contentHash } from '../../packages/roundtable/src/canonical-json.js';
import { latestPlan } from '../graphiti/project-agent-task-sheets.js';
import { MIN_STEPS, normalizedStep, plansAlike } from './step-similarity.js';
import { cancelIfOpen } from './attention-requests.js';

// Repeated work becomes a workflow or a tool (rec#78, 11-06 addition 3;
// Jevons 11-23). When one FLA does the same kind of work across several
// finished tasks in one project, it is not written into a prompt again:
// - the person is asked once (待决策) whether that FLA should make a script of
//   it, only write the steps down, or leave it;
// - the FLA hears about it in its next conversation there (entry-hint.js), and
//   hears the person's answer once they give it.
// Model-free: "the same kind of work" is step-similarity.js (each plan has at
// least three steps, and 60% of the longer one pairs off with alike steps of
// the other), in at least MIN_TASKS completed tasks among an FLA's most recent
// MAX_TASKS in the space; or an active workflow that ran through at one version
// in MIN_TASKS tasks. Nothing is built here, and nothing without the person's yes.
const MIN_TASKS = 3;
const TASK_PAGE = 100;
const MAX_TASKS = 500;
const SHOWN_STEPS = 8;
const ANSWER_PAGE = 200;
// Three choices the person can tell apart, in their own words: a thing that
// runs (an Agent app, confirmed once in the terminal), a thing that is only
// written down (a workflow; this choice is the confirmation), or no.
const SCRIPT = '做成能跑的脚本';
const STEPS = '只记下这串步骤';
const NO = '不用';
// 0.29 betas offered 「做成脚本」 and 「做成 Agent App」: both are what SCRIPT makes now, so an answer
// the person gave in that wording is kept, never asked again.
const ANSWERS = Object.freeze({ [SCRIPT]: 'script', [STEPS]: 'steps', [NO]: 'no', 做成脚本: 'script', '做成 Agent App': 'script' });
// The wording 0.29 betas asked in: an open request in it is cancelled once, as it offered "Agent App".
const LEGACY_TITLE = /这串步骤已重复 \d+ 次以上，要做成工具吗？$/u;

// Completed tasks, newest first, a page at a time up to MAX_TASKS.
async function completedTasks(app, personalSpaceId) {
  const tasks = [];
  let after = null;
  while (tasks.length < MAX_TASKS) {
    const page = await app.listProjectAgentTasks({ personalSpaceId, status: 'completed', limit: TASK_PAGE,
      afterUpdatedAt: after?.updatedAt ?? null, afterTaskId: after?.taskId ?? null });
    // A Provider that does not know the cursor answers with the first page again: stop, never loop.
    const fresh = page.filter(task => !tasks.some(seen => seen.taskId === task.taskId));
    tasks.push(...fresh);
    if (page.length < TASK_PAGE || !fresh.length) break;
    after = page.at(-1);
  }
  return tasks;
}

// One FLA's plan per finished task, grouped by the same kind of work. The
// oldest task of a group stands for it, so the group keeps its key as tasks join.
export function repeatedPlans(tasks) {
  const groups = [];
  const ordered = [...tasks].sort((a, b) => String(a.updatedAt ?? '').localeCompare(String(b.updatedAt ?? ''))
    || String(a.taskId).localeCompare(String(b.taskId)));
  for (const task of ordered) {
    if (task.status !== 'completed' || !task.personalProjectId) continue;
    const byAgent = new Map();
    for (const step of latestPlan(task.events)?.steps ?? []) {
      if (step.status === 'skipped') continue;
      const agentId = step.agentId ?? task.leadAgentId;
      if (agentId) byAgent.set(agentId, [...(byAgent.get(agentId) ?? []), step.title]);
    }
    for (const [agentId, steps] of byAgent) {
      if (steps.length < MIN_STEPS) continue;
      const group = groups.find(entry => entry.agentId === agentId && entry.personalProjectId === task.personalProjectId
        && plansAlike(entry.steps, steps));
      if (group) {
        if (!group.tasks.some(seen => seen.taskId === task.taskId)) group.tasks.push({ taskId: task.taskId, title: task.title });
        continue;
      }
      groups.push({ key: contentHash({ agentId, personalProjectId: task.personalProjectId, steps: steps.map(normalizedStep) }),
        agentId, personalProjectId: task.personalProjectId, steps, tasks: [{ taskId: task.taskId, title: task.title }] });
    }
  }
  return groups.filter(group => group.tasks.length >= MIN_TASKS);
}

// An active workflow its FLA ran done at the same version in enough tasks.
function repeatedWorkflows(workflows) {
  const found = [];
  for (const { agentId, workflow } of workflows) {
    if (workflow.status !== 'active' || !workflow.active || !workflow.personalProjectId) continue;
    const done = new Set(workflow.recentRuns.filter(run => run.outcome === 'done' && run.taskId
      && run.version === workflow.active.version).map(run => run.taskId));
    if (done.size < MIN_TASKS) continue;
    found.push({ key: contentHash({ workflowId: workflow.workflowId, version: workflow.active.version }), agentId,
      personalProjectId: workflow.personalProjectId, steps: workflow.active.steps.map(step => step.title),
      tasks: [...done].map(taskId => ({ taskId, title: null })), workflowName: workflow.active.name });
  }
  return found;
}

// One tick: find repeats, note each for its FLA, ask the person about each
// once, and read back the answers given since. A repeat the FLA already
// deposited, or the person answered, is not asked about again; a request
// already open in this wording is not sent again (no Provider call at all).
export async function suggestRepeatedTools(app, state = { legacyCleared: false, legacyAnswers: [] }) {
  const personalSpaceId = app.config.personal.spaceId;
  const workflows = app.agentWorkflows ?? null;
  const tasks = await completedTasks(app, personalSpaceId);
  const active = [];
  for (const row of workflows?.listSpace({ personalSpaceId }) ?? []) {
    if (row.status !== 'active') continue;
    const workflow = workflows.overview({ personalSpaceId, agentId: row.agentId }).workflows
      .find(entry => entry.workflowId === row.workflowId);
    if (workflow) active.push({ agentId: row.agentId, workflow });
  }
  if (!state.legacyCleared) state.legacyCleared = await cancelLegacy(app, personalSpaceId, state);
  // Answers first, so a request the person just answered is not asked again in new words.
  await readAnswers(app, personalSpaceId);
  const asked = [];
  for (const repeat of [...repeatedPlans(tasks), ...repeatedWorkflows(active)]) {
    // One that cannot be asked now (its FLA left the project, say) keeps the others going.
    try {
      if (await askOnce(app, personalSpaceId, repeat, state.legacyAnswers ?? [])) asked.push({ agentId: repeat.agentId, personalProjectId: repeat.personalProjectId, tasks: repeat.tasks.length });
    } catch { /* asked again on a later tick */ }
  }
  return { asked };
}

async function askOnce(app, personalSpaceId, repeat, legacyAnswers) {
  const request = attentionFor(personalSpaceId, repeat);
  const wording = contentHash({ title: request.title, detail: request.detail, requestedAction: request.requestedAction,
    options: request.options }).slice(0, 12);
  const hint = app.agentWorkflows?.noteRepeat?.({ key: repeat.key, personalSpaceId, agentId: repeat.agentId,
    personalProjectId: repeat.personalProjectId, kind: repeat.workflowName ? 'workflow' : 'steps',
    name: String(repeat.workflowName ?? repeat.steps[0]).slice(0, 120), steps: repeat.steps, taskCount: repeat.tasks.length });
  if (hint && (hint.depositedAt || hint.answer || hint.requestWording === wording)) return false;
  // Answered in the 0.29 beta wording: that answer stands, for one repeat only.
  const earlier = hint && !hint.requestId ? legacyAnswers.find(item => item.agentId === repeat.agentId
    && item.personalProjectId === repeat.personalProjectId && plansAlike(listedSteps(item.detail), repeat.steps)) : null;
  if (earlier) {
    legacyAnswers.splice(legacyAnswers.indexOf(earlier), 1);
    app.agentWorkflows.repeatRequested(hint.key, earlier.requestId, wording);
    app.agentWorkflows.repeatAnswered(hint.key, answerOf(earlier));
    return false;
  }
  // The wording changed since the person was asked: the old request goes, unanswered ones only.
  // One no longer open was answered or closed by the person (in words FULI cannot read as a
  // choice, or it would be recorded already): it is not asked again.
  if (hint?.requestId && await cancelIfOpen(app, { personalSpaceId, requestId: hint.requestId,
    reason: 'FULI asks this again in clearer words.' }) === 'not_open') {
    app.agentWorkflows.repeatRequested(hint.key, hint.requestId, wording);
    return false;
  }
  const record = await app.requestAgentAttention({ ...request, idempotencyKey: `tool-suggestion:${repeat.key}:${wording}` });
  if (hint) app.agentWorkflows.repeatRequested(hint.key, record?.requestId ?? null, wording);
  return true;
}

// Answers the person gave since the last tick, read once per tick and only when one is awaited.
async function readAnswers(app, personalSpaceId) {
  const awaiting = app.agentWorkflows?.awaitingAnswer?.({ personalSpaceId }) ?? [];
  if (!awaiting.length) return;
  let resolved;
  try { resolved = (await app.listAgentAttention({ personalSpaceId, status: 'resolved', limit: ANSWER_PAGE })).items ?? []; }
  catch { return; }
  for (const hint of awaiting) {
    const reply = resolved.find(item => item.requestId === hint.requestId);
    const answer = answerOf(reply);
    if (answer) app.agentWorkflows.repeatAnswered(hint.key, answer);
  }
}

const answerOf = reply => ANSWERS[String(reply?.response ?? '').split('\n')[0].trim()];
// The steps a request listed, one per numbered line.
const listedSteps = detail => String(detail ?? '').split('\n').map(line => /^\d+\. (.+)$/u.exec(line)?.[1]).filter(Boolean);

// Requests asked in the 0.29 beta wording that nobody answered yet are cancelled
// once; the ones the person answered are kept for their repeats (askOnce).
async function cancelLegacy(app, personalSpaceId, state) {
  if (!app.listAgentAttention) return true;
  try {
    const { items = [] } = await app.listAgentAttention({ personalSpaceId, status: 'open', limit: ANSWER_PAGE });
    for (const item of items.filter(entry => LEGACY_TITLE.test(entry.title ?? ''))) {
      await cancelIfOpen(app, { personalSpaceId, requestId: item.requestId, reason: 'FULI asks this again in clearer words.' });
    }
    const { items: resolved = [] } = await app.listAgentAttention({ personalSpaceId, status: 'resolved', limit: ANSWER_PAGE });
    state.legacyAnswers = resolved.filter(entry => LEGACY_TITLE.test(entry.title ?? '') && answerOf(entry)
      && !app.agentWorkflows?.requestUsed?.(entry.requestId));
    return true;
  } catch { return false; }
}

// The same request every tick: it names the steps and the threshold only,
// never a count that changes as more tasks are finished.
function attentionFor(personalSpaceId, repeat) {
  const name = repeat.workflowName ?? repeat.steps[0];
  const steps = repeat.steps.slice(0, SHOWN_STEPS).map((title, index) => `${index + 1}. ${title}`);
  const workflow = Boolean(repeat.workflowName);
  return { personalSpaceId, personalProjectId: repeat.personalProjectId, agentId: repeat.agentId, kind: 'approval',
    title: (workflow ? `「${name}」已经跑通 ${MIN_TASKS} 次以上，要做成能跑的脚本吗？`
      : `「${name}」这类事已做了 ${MIN_TASKS} 次以上，要沉淀下来吗？`).slice(0, 160),
    detail: [workflow ? `这串步骤在 ${MIN_TASKS} 个以上任务里都跑通了：` : `同一类事，在 ${MIN_TASKS} 个以上任务里做过，步骤大致是：`, ...steps,
      ...(repeat.steps.length > SHOWN_STEPS ? [`……共 ${repeat.steps.length} 步`] : [])].join('\n').slice(0, 4096),
    // What each choice makes the FLA do travels with the reply it receives (the request's question).
    requestedAction: (workflow ? '点一个就行：' : '点一个就行：「只记下这串步骤」它会写成一份步骤清单，你这次点的就算确认，不用再点；')
      + `「${SCRIPT}」它会把每次都跑的命令交成一个 Agent 应用，你到 Agents → 应用点「确认」，会打开终端，输入应用名就能用；`
      + `「${NO}」就照旧。不经你同意什么都不做。`,
    options: workflow ? [SCRIPT, NO] : [STEPS, SCRIPT, NO] };
}

// A tick on the console host only. Each repeat is asked once, so a tick
// repeats nothing; a failed tick is tried on the next.
export function startToolSuggestionScheduler({ app, withLease = (_owner, run) => run(), intervalMs = 3_600_000 }) {
  let running = false, active = null, stopped = false;
  const state = { legacyCleared: false, legacyAnswers: [] };
  const tick = async () => {
    if (stopped || running || app.getAgentAccessPolicy?.().enabled === false) return;
    running = true;
    try { await withLease('tool-suggestions', () => suggestRepeatedTools(app, state)); }
    catch { /* The next tick tries again. */ }
    finally { running = false; }
  };
  const timer = setInterval(() => { if (!running && !stopped) active = tick(); }, intervalMs);
  timer.unref?.();
  // Synchronous unless a tick is running, so a shutdown waits for nothing else.
  return () => { stopped = true; clearInterval(timer); return active; };
}
