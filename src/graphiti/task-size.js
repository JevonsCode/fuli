// How much work a prompt asks for, as far as FULI can tell from the words
// (rec#146 item 2). A task entry told every turn to call plan_agent_collaboration
// before implementing and to publish an execution plan, including for "change
// this one setting" and "create one table" — two extra round trips on work that
// is over in two commands.
//
// Only positive evidence makes a task small, and any sign of building something
// takes it back: a large task that loses its division rule costs far more than
// a small one that keeps it. FULI never guesses upward.
import { taskWorkKind } from './task-scene.js';

// Asking about something, not changing it.
const READ_ONLY = new RegExp('^\\s*(?:看一?下|查一?下|读一?下|列一?下|确认一?下|搜一?下|找一?下|是什么|为什么|怎么'
  + '|哪|多少|有没有|能不能|show|list|check|read|find|search|explain|what|why|where|which|who|when'
  + '|how many|is there|can you tell)', 'iu');
// One mechanical change, named as such.
const ONE_SMALL_CHANGE = new RegExp('(?:改一?个|加一?个|删一?个|换一?个|改成|调一?下|跑一?下|执行一?下'
  + '|建一?张表|bump|typo|one setting|single (?:line|field|flag|setting|file)|revert|re-?run)', 'iu');
// A rename is small only when it names one thing ("rename this field",
// "把这个字段重命名"): renaming a module, an API or a name used everywhere
// touches every caller and is work to divide (review of #1076).
const ONE_RENAME = new RegExp('(?:(?:这个|这一个|该|一个)[^，。,.]{0,12}(?:改名|重命名)|(?:改名|重命名)[^，。,.]{0,4}(?:这个|一个)'
  + '|rename (?:this|that|the|one|a) (?:[\\w-]+ ){0,2}(?:field|flag|variable|column|key|label|setting|file|constant|parameter|button)s?\\b)', 'iu');
// Breadth a rename can carry: never small.
const WIDE = new RegExp('(?:所有|全部|全局|整个|全仓|各处|everywhere|across|all |every |codebase|repository|module|package|api)', 'iu');
// A command the person spells out: at most a couple of them, nothing to divide.
const COMMAND_ONLY = new RegExp('^\\s*(?:跑|运行|执行|run|exec)\\b|^\\s*(?:npm|pnpm|yarn|make|git|node|python|pytest'
  + '|cargo|go)\\s', 'iu');
// Building, changing or moving something: never small, whatever else matches.
const BUILDING = new RegExp('(?:实现|重构|重写|设计|迁移|接入|开发|搭建|拆分|整体|全量|方案|端到端|上线|发布'
  + '|implement|refactor|rewrite|redesign|migrate|port\\b|build|integrate|end-to-end|roll ?out|release'
  + '|architecture)', 'iu');
// More than one thing asked for in one prompt.
const SEVERAL = new RegExp('(?:然后|接着|并且|同时|分别|以及|and then|after that)', 'iu');
// Past this a prompt is describing work, not naming a small change.
const SHORT_CHARS = 120;

export const SMALL = 'small';
export const STANDARD = 'standard';

// 'small' only with evidence; 'standard' whenever FULI cannot tell.
export function taskSize(taskPrompt, workKind = null) {
  if (typeof taskPrompt !== 'string' || !taskPrompt.trim()) return STANDARD;
  const prompt = taskPrompt.trim();
  const kind = workKind ?? taskWorkKind(prompt);
  if (kind === 'chat') return SMALL;
  if (BUILDING.test(prompt) || SEVERAL.test(prompt) || prompt.length > SHORT_CHARS) return STANDARD;
  const oneRename = ONE_RENAME.test(prompt) && !WIDE.test(prompt);
  return READ_ONLY.test(prompt) || COMMAND_ONLY.test(prompt) || ONE_SMALL_CHANGE.test(prompt) || oneRename ? SMALL : STANDARD;
}

// The task_guidance keys a small task is not told about: dividing the work
// between Agents and publishing a public execution plan. The rules keep them,
// and the entry names them as not applying here, so nothing is hidden.
const NOT_FOR_SMALL = Object.freeze(['collaboration', 'execution_plan']);

// The task_guidance of one task: the whole set, or the set without the rules a
// task this size has nothing to divide for.
export function taskGuidanceFor(guidance, size) {
  if (size !== SMALL) return guidance;
  return Object.fromEntries(Object.entries(guidance).filter(([key]) => !NOT_FOR_SMALL.includes(key)));
}
