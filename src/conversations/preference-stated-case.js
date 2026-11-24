// The case a habit states it applies in, read the one way every caller reads
// it: an entry deciding whether to spell a habit out (preference-conditions.js),
// the console's graph read, organize_project's page and the applies-when route.
// A pure judgment of the item alone: it imports nothing that reaches an entry,
// MCP or conversation module, so a management path that needs it does not pull
// the entry's chain (and Astro's model call) in with it.
//
// - A hard rule is conditional only by an `appliesWhen` or an opening that
//   says it *applies* only there; 「仅限…」 / "Only for…" limit an action, for
//   every task (preference-index.js statedScope).
// - A case that means every task (「总是」「默认」「所有任务」「always」「by
//   default」) is no case: the habit is unconditional.
import { singleLine } from '../text/single-line.js';
import { distinctiveUnits, statedScope } from './preference-index.js';
import { preferenceAlwaysInline, preferenceAppliesWhen } from '../graphiti/preference-task-scope.js';

// A case is shown whole in its own words up to this; past it, cut.
const CONDITION_CHARS = 120;
// A case that means every task: one of these words, and nothing else of
// substance once these and generic nouns are out.
const UNIVERSAL = /总是|始终|一直|默认|全部|所有|任何|任意|每次|每个|一切|\b(?:always|any|every|all|default|everywhere|anytime|whenever)\b/iu;
const GENERIC = /总是|始终|一直|默认|全部|所有|任何|任意|每次|每个|一切|任务|工作|时候|情况|场景|项目|对话|会话|类型|种类|事情|都|时|\b(?:always|any|every|all|by|default|everywhere|anytime|whenever|in|on|at|of|the|a|an|kinds?|types?|tasks?|work|cases?|situations?|projects?|times?|sessions?|conversations?)\b/giu;

// The case a habit states, as { text, units, end }, or null for a habit
// without one. `appliesWhen` (free text a person or Agent wrote) wins over a
// case the instruction states in its opening words; a habit that states
// neither, or states every task, is unconditional, whatever its words seem to
// be about. `end`: where an opening that states the case ends in the
// instruction (0 where it opens with the rule itself).
export function preferenceCondition(item) {
  const instruction = typeof item?.instruction === 'string' ? item.instruction : '';
  const opening = statedScope(instruction, { explicitOnly: preferenceAlwaysInline(item) });
  const appliesWhen = preferenceAppliesWhen(item);
  const phrase = appliesWhen ?? opening?.phrase;
  if (!phrase || universal(phrase)) return null;
  const flat = singleLine(phrase).replace(/\s+/gu, ' ');
  const text = [...flat].length > CONDITION_CHARS ? `${[...flat].slice(0, CONDITION_CHARS - 1).join('').trimEnd()}…` : flat;
  return { text, units: distinctiveUnits(phrase), end: opening?.end ?? 0 };
}

function universal(phrase) {
  return UNIVERSAL.test(phrase) && !distinctiveUnits(phrase.replace(GENERIC, ' ')).length;
}
