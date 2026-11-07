import { STATED_RULE_PATTERNS } from '../graphiti/task-stated-rules.js';
import { personWords } from './person-words.js';

// What a finished turn showed by itself (rec#88 compounding eval): a task the
// Stop hook closes has no model checkpoint, so what the Agent found out was
// lost every time — the command a test run needs first, the project's checks,
// a convention it spelled out. From the turn's own tool runs and final reply,
// with no model call, this returns at most a few reusable experiences; the
// checkpoint keeps them pending, for the usual review. Agent-agnostic: each
// host adapter supplies its normalized transcript records
// ({ kind: 'tool_call' | 'tool_result', content: JSON }) for the turn, with
// the turn's prompt as { role: 'user', kind: 'message' } where it has it. A
// turn the host started with only its own note (a <side-sessions-event>, a
// <task-notification>) answers that note, so its reply relays someone else's
// report: the turn's runs are still the task's own, its reply is not kept.
const MAX_FINDINGS = 3;
const ERROR_LINE = /(?:Error|ENOENT|not found|Cannot find|No such file|failed)/u;
// A project script, as a person would type it again.
const PROJECT_SCRIPT = /^(?:npm (?:test|t|run [\w:.-]+)|pnpm (?:test|run [\w:.-]+|[\w:.-]+)|yarn (?:test|run [\w:.-]+|[\w:.-]+)|make [\w.-]+)\b/u;
const DENIED = /^(?:This (?:Bash )?command|A variable in braces|Permission to use)|require[sd]? approval/u;
const REPLY_RULES = [...STATED_RULE_PATTERNS,
  /\bconvention\b[^.?!]*?(?::|\b(?:is|are)\b)/iu,
  /\bmust be (?:listed|registered|added)\b/iu];

export function turnFindings(records, reply = null) {
  const runs = shellRuns(records);
  const findings = [prerequisite(runs), projectChecks(runs), ...(personDriven(records) ? replyRules(reply) : [])].filter(Boolean);
  const seen = new Set();
  return findings.filter(item => !seen.has(item.task) && seen.add(item.task)).slice(0, MAX_FINDINGS);
}

// The person wrote something in the turn's prompt; records without the prompt
// are taken as the person's turn.
function personDriven(records = []) {
  const prompts = records.filter(record => record?.role === 'user' && record.kind === 'message');
  return !prompts.length || prompts.some(record => personWords(record.content));
}

// Each shell call with its project scripts and outcome, in order.
function shellRuns(records = []) {
  const calls = [];
  const results = new Map();
  for (const record of records) {
    const value = parse(record?.content);
    if (!value) continue;
    if (record.kind === 'tool_call' && typeof (value.input?.command ?? value.input?.cmd) === 'string') {
      calls.push({ id: value.call_id, command: value.input.command ?? value.input.cmd });
    } else if (record.kind === 'tool_result') results.set(value.call_id, value);
  }
  return calls.filter(call => results.has(call.id)).map(call => {
    const result = results.get(call.id);
    const output = outputText(result.output);
    return { scripts: projectScripts(call.command), output, denied: DENIED.test(output.slice(0, 300)),
      failed: result.is_error === true || /\bExit code [1-9]/u.test(output.slice(0, 200)) };
  // A call the host refused to run (a permission prompt) showed nothing about the project.
  }).filter(run => run.scripts.length && !run.denied);
}

// A script that failed alone, then passed once another script had run first:
// the one chained right before it in the passing call, else the most recent
// clean script in between. A failed chain of several scripts names no culprit.
function prerequisite(runs) {
  for (const [index, failed] of runs.entries()) {
    if (!failed.failed || failed.scripts.length !== 1) continue;
    const [target] = failed.scripts;
    const later = runs.slice(index + 1);
    const passed = later.findIndex(run => !run.failed && run.scripts.includes(target));
    if (passed < 0) continue;
    const chained = later[passed].scripts.slice(0, later[passed].scripts.indexOf(target)).filter(script => script !== target);
    const between = later.slice(0, passed).filter(run => !run.failed).flatMap(run => run.scripts).filter(script => script !== target);
    const first = chained.at(-1) ?? between.at(-1);
    if (!first) continue;
    const cause = shortPaths(failed.output.split(/\r?\n/u).map(line => line.trim()).find(line => ERROR_LINE.test(line)));
    return { task: `Run \`${first}\` before \`${target}\``,
      solution: `\`${target}\` failed until \`${first}\` had run${cause ? ` (first error: ${cause.slice(0, 160)})` : ''}.`,
      searchKeys: [...new Set([target, first, ...words(cause ?? '')])].slice(0, 8) };
  }
  return null;
}

// The project scripts the turn ran clean after its last failure, sorted so the
// same checks read the same in every task (one item, not one per order).
function projectChecks(runs) {
  const lastFailure = runs.findLastIndex(run => run.failed);
  const scripts = [...new Set(runs.slice(lastFailure + 1).filter(run => !run.failed).flatMap(run => run.scripts))].sort();
  if (!scripts.length) return null;
  const list = scripts.map(script => `\`${script}\``).join(', ');
  return { task: `Project checks: ${list}`, solution: `These project scripts ran clean at the end of a finished task: ${list}.`,
    searchKeys: [...scripts, 'checks'].slice(0, 8) };
}

// Sentences of the final reply that state a project rule (a convention, a port,
// a command, a cause), outside any host note or quoted report it carries.
function replyRules(reply) {
  const own = personWords(reply);
  if (!own) return [];
  return own.split(/(?<=[.!?])\s+|(?<=[。！？])|\r?\n/u)
    .map(sentence => sentence.replace(/^[\s>*•-]+|\*\*/gu, '').trim())
    .filter(sentence => sentence.length >= 20 && !/[?？]$/u.test(sentence) && REPLY_RULES.some(pattern => pattern.test(sentence)))
    .slice(0, 1)
    .map(sentence => ({ task: sentence.slice(0, 240), solution: sentence.slice(0, 600), searchKeys: words(sentence).slice(0, 8) }));
}

function projectScripts(command) {
  return command.split(/&&|\|\||;|\r?\n/u)
    .map(part => part.split('|')[0].replace(/\s+[12]?>.*$/u, '').replace(/\s+/gu, ' ').trim())
    .map(part => PROJECT_SCRIPT.exec(part)?.[0])
    .filter(Boolean);
}

// An absolute path keeps its last three parts: where on this machine the
// project lives (a home or user folder) is no project knowledge.
const LONG_PATH = /(?:[A-Za-z]:)?[\\/](?:[^\\/'"\s]+[\\/])+(?=(?:[^\\/'"\s]+[\\/]){2}[^\\/'"\s]+)/gu;
function shortPaths(line) {
  return line?.replace(LONG_PATH, '…/');
}

function outputText(output) {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) return output.map(block => (typeof block === 'string' ? block : block?.text ?? '')).join('\n');
  return '';
}

function words(text) {
  return [...new Set((String(text).match(/[A-Za-z][\w./-]{3,}/gu) ?? []).map(word => word.toLowerCase()))];
}

function parse(content) {
  try {
    return typeof content === 'string' ? JSON.parse(content) : null;
  } catch {
    return null;
  }
}
