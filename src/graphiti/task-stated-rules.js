import { compactTaskCapture } from './task-remember.js';
import { normalizeTaskCaptures, taskCaptureInput } from './task-knowledge-routing.js';
import { taskCaptureScope } from './capture-decision.js';
import { checkpointCaptureDecision } from './checkpoint-capture.js';
import { taskStatement } from './task-prompt-statement.js';

// What the person states as a standing project rule in a prompt (rec#88
// compounding eval): a policy or convention of theirs, a port, the command to
// run, or why something fails. A task the Stop hook closes by itself is closed
// without a model checkpoint, and models judged even "Our retry policy …: at
// most 3 attempts …" not worth keeping, so the project never learned it. The
// hook entry keeps such sentences itself, in the person's own words, as
// pending project facts: the existing review (a person, or Tonborg under its
// policy) decides whether they stand. Questions, requests and notes are never
// statements; nothing the model wrote is read here.
const MAX_RULES = 3;
const MAX_RULE_CHARS = 600;
export const STATED_RULE_PATTERNS = [
  // "Our retry policy for every outbound channel: …", "our deploy command is …"
  /\bour\s+(?:[\w./-]+\s+){0,6}?(?:policy|policies|convention|conventions|rule|rules|standard|port|ports|command|commands|process|workflow|naming)\b[^.?!]*?(?::|\b(?:is|are)\b)/iu,
  // "We always run the migrations first", "we never retry a 4xx"
  /\bwe\s+(?:always|never|only)\s+\w+/iu,
  // "the staging port is 4611", "admin port = 7310"
  /\bport\s+(?:is|=|:)\s*\d{2,5}\b/iu,
  // "the tests fail because …", "the root cause was …", "the fix is to …"
  /\b(?:fails?|failed|failing|breaks?|broke)\b[^.?!]*\bbecause\b|\broot cause\b|\bthe fix (?:is|was)\b/iu,
  // 「我们的重试策略：…」「我们的部署命令是…」
  /我们(?:的)?[^，。；！？\n]{0,20}(?:策略|约定|规范|规则|端口|命令|流程)(?:是|为|：|:)/u,
  // 「约定是…」「规定：…」「端口是 4611」
  /(?:约定|规定|规范)(?:是|为|：|:)|端口(?:是|为|：|:)\s*\d{2,5}/u,
  // 「我们总是先…」「一律…」「失败的原因是…」
  /我们(?:总是|一律|从不|只用|都用)|(?:失败|报错|挂掉?)(?:的)?原因(?:是|在于)|根本原因|是因为/u
];
const QUESTION = /[?？]\s*$|吗[。.]?\s*$/u;
const SENTENCES = /(?<=[.!?])\s+(?=[A-Z0-9`"'(])|(?<=[。！？])|\r?\n/u;

// The sentences of a prompt that state a project rule, as written, at most a few.
export function statedProjectRules(prompt) {
  if (typeof prompt !== 'string' || !prompt.trim()) return [];
  const sentences = taskStatement(prompt).split(SENTENCES).map(sentence => sentence.trim()).filter(Boolean);
  const rules = sentences.filter(sentence => !QUESTION.test(sentence) && STATED_RULE_PATTERNS.some(pattern => pattern.test(sentence)))
    .map(sentence => sentence.slice(0, MAX_RULE_CHARS));
  return [...new Set(rules)].slice(0, MAX_RULES);
}

// Keeps the prompt's stated rules for a hook-entered task as pending project
// facts in its project, under the same capture policy as a checkpoint. Its own
// idempotency key, so a later model checkpoint of the task is not a replay of
// it. Null when nothing was stated or the task has no project; never throws
// for the caller to handle as an entry failure.
export async function keepStatedRules(application, task, prompt, { decide = checkpointCaptureDecision } = {}) {
  const rules = statedProjectRules(prompt);
  if (!rules.length || !task?.personalProjectId) return null;
  const decision = await decide(application, task);
  if (!decision.allowed) return { status: 'capture_disabled', count: 0 };
  const { capture, captureRouting } = compactTaskCapture(task,
    { remember: rules.map(text => ({ kind: 'project_fact', text })) }, { sourceApplication: task.sourceApplication });
  const batches = normalizeTaskCaptures(task, capture, captureRouting);
  let kept = 0;
  for (const batch of batches) {
    const input = { ...taskCaptureInput(application.config.personal.spaceId, task, batch),
      idempotencyKey: `${task.token}:stated:${batch.scope}` };
    const result = await application.captureSessionKnowledge(input, { captureScope: taskCaptureScope(task) });
    if (['committed', 'duplicate'].includes(result?.status)) kept += batch.capture.entities.length;
  }
  return { status: kept ? 'kept' : 'not_kept', count: kept };
}
