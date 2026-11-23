import { personWords } from '../conversations/person-words.js';
import { withoutFuliMarkup } from './fuli-markup.js';

// "I already told you, why don't you …" (Jevons 11-24). A person who has to
// say a thing again is telling FULI it should have been kept: an Agent that
// only apologises and complies makes the same mistake in the next session.
//
// Model-free and on purpose narrow. A match costs the turn its automatic
// close and adds a paragraph of guidance; a miss costs one more reminder. So
// precision comes first:
// - only the person's own words count: host markup, quoted text, code, log
//   lines and what someone else said or wrote (「PM 说：…」, "The customer
//   wrote: …") are taken out first;
// - a sentence that talks about such a phrase rather than saying it (如果,
//   帮我写, 匹配, regex, "write a test") is skipped;
// - each pattern needs the person to point at something THEY said or did
//   before AND at the Agent not following it, or to complain that it happened
//   AGAIN. "why", "already", "last time" or "I said" alone never match.
const QUOTED = /"[^"\n]*"|“[^”\n]*”|「[^」\n]*」|『[^』\n]*』|‘[^’\n]*’|```[\s\S]*?```|`[^`\n]*`/gu;
const LOG_LINE = /^\s*(?:\[?\d{4}-\d{2}-\d{2}|\[?\d{1,2}:\d{2}:\d{2}|\[?(?:ERROR|WARN(?:ING)?|INFO|DEBUG|TRACE|FATAL)\b)/u;
// What follows a label or someone else's words is theirs, to the end of the line.
const LABEL = /(?:日志|工单|报错|报告|反馈|原文|截图|输出|\b(?:logs?|error|output|ticket|report|transcript))\s*[:：]/iu;
const REPORTED = /([^\s，。！？,.!?:：]{1,12}?)(?:说|问|写道|写着|反馈|回复|留言|提到|评论)(?:我|你)?[:：]/u;
const REPORTED_EN = /(?<!['’])\b(\w+)\s+(?:said|says|wrote|writes|asked|asks|replied|commented)(?:\s+\w+){0,2}\s*:/iu;
const ABOUT_THE_WORDS = /如果|假如|假设|帮我写|写个|写一个|匹配|正则|例如|比如|\bif I\b|\bregex\b|\bwrite (?:a|an|me a) (?:test|regex|example|pattern)|\bfor example\b/iu;
const SENTENCES = /(?<=[。！？!?])|(?<=\.)\s+|\r?\n/u;

const IMPERATIVE = '(?:别|不要|不许|不准|一定要|要用|用|改成)';
const REPEAT_PATTERNS = [
  // 「我已经说过了」「我早就讲过了」: said before, and said so
  /我(?:都|早就?|明明|之前|前面|刚才)?(?:已经)?(?:说|讲|强调|交代)过了/u,
  // 「我早就讲了，别动 lockfile」「我说过别用 any」: what I said, then the rule again
  // (「我之前说过要用 Redis，但…」 is a plan changing, not a complaint)
  new RegExp(`我(?:都|早就?|明明|已经|之前|前面|上次|刚才)*(?:说|讲|强调|交代|要求)(?:过|了)?(?:[，,]\\s*${IMPERATIVE}|别|不要|不许|不准)`, 'u'),
  // 「我跟你说过这个接口要带分页」, not 「上次跟你说过的那个方案」
  /我(?:都|早就?|明明|已经|之前|前面|上次|刚才)*(?:跟|和)你(?:说|讲|提)(?:过|了)(?!的)/u,
  // 「我之前让你别动配置」
  /我(?:之前|上次|刚才|前面|早就|都|已经|明明)+(?:让|叫|要)你(?:别|不要|不许|用|改|加|先)/u,
  // 「我已经把端口改了，为什么你还不用」「我前面已经把端口改了你怎么还在用 3000」
  /我[^。！？!?\n]{0,6}已经[^。！？!?\n]{1,40}?了[，,]?\s*(?:为什么|为啥)?你(?:怎么)?(?:还|又|就|都)(?:在|是)?(?:不|没|用|这样|写|改)/u,
  // 「都说了别用 any」「说好的不要加注释呢」
  new RegExp(`都说了[，,]?\\s*(?:${IMPERATIVE.slice(3, -1)}|让你|多少)`, 'u'),
  /说好的[^。！？!?\n]{1,30}呢/u,
  // 「之前不是让你用 pnpm 吗」「不是跟你说过了」
  /不是(?:让你|叫你|跟你说|跟你讲|和你说|说过|讲过|说了|讲了)[^。！？!?\n]{0,30}吗/u,
  /不是(?:跟你|和你)(?:说|讲)(?:过|了)/u,
  // 「上次就说过」 (就: said, and said already)
  /(?:上次|上回|之前|刚才|前面)就(?:跟你)?(?:说|讲|提|强调)(?:过|了)/u,
  // 「说了多少遍」「跟你讲了多少回了」
  /(?:说|讲|提|强调)(?:了|过)(?:多少|好几|很多|几|N)(?:遍|次|回)/u,
  // The Agent doing it again: 「你又把测试删了」「又忘了」「老是忘记」「上次你就是这么改坏的」
  /你(?:又|老是|总是)(?:把|忘|没|不|用|在用|改|删|加)/u,
  /你怎么(?:又|还)(?:在)?(?:用|写|改|加|删|忘|没|不)/u,
  /又忘了|怎么又忘|(?:老是|总是)忘/u,
  /上次你就是这么/u,
  /第[二三四五六七八九十几\d]+次了[，,]?\s*(?:别|不要|还|你)/u,
  /又来了[，,]\s*(?:还是|又)/u,
  // English
  /\bI(?:'ve| have)? (?:already )?told you\b/iu,
  /\bI said no\b/iu,
  /\bI(?:'ve| have) said (?:this|that|it) (?:before|already|twice|again)\b/iu,
  /\bI (?:already )?(?:mentioned|said) (?:it|this|that) (?:already|before|twice)\b/iu,
  /\bI (?:already )?asked you (?:before|already|twice|to)\b/iu,
  /\b(?:as|like) I (?:said|mentioned|told you)(?: (?:before|earlier|last time|already))?[,:]/iu,
  /\bdidn'?t I (?:say|tell you|ask you|mention)\b/iu,
  /\bhow many times (?:do|have|must|did) (?:I|you)\b/iu,
  /\bI(?:'ve)? already [^.!?\n]{1,60}?\bwhy (?:didn'?t|don'?t|did not|do not|won'?t|aren'?t|haven'?t) you\b/iu,
  /\byou (?:keep|kept) (?:forgetting|ignoring)\b/iu,
  /\byou forgot\b[^.!?\n]{0,40}\bagain\b/iu,
  /\bwe(?:'ve| have)? (?:already )?(?:talked|discussed|been over) (?:about )?(?:this|that)\b/iu,
  /(?:^|[.!?]\s+)again,\s/iu
];

// The person's own sentences, with what is not theirs taken out.
export function ownSentences(prompt) {
  const own = withoutFuliMarkup(personWords(prompt));
  if (!own) return [];
  return own.replace(QUOTED, ' ').split(/\r?\n/u)
    .filter(line => !LOG_LINE.test(line))
    .map(line => cutAt(cutAt(cutAt(line, LABEL), REPORTED, speaker => !/[我你]$/u.test(speaker)),
      REPORTED_EN, speaker => !/^(?:I|you|we)$/iu.test(speaker)))
    .join('\n').split(SENTENCES).map(sentence => sentence.trim()).filter(Boolean);
}

function cutAt(line, pattern, applies = () => true) {
  const match = pattern.exec(line);
  return match && applies(match[1] ?? '') ? line.slice(0, match.index) : line;
}

// True when the person says they already asked for this; the sentence is the evidence.
export function repeatComplaint(prompt) {
  return ownSentences(prompt).some(sentence => !ABOUT_THE_WORDS.test(sentence)
    && REPEAT_PATTERNS.some(pattern => pattern.test(sentence)));
}

// Sent only on a turn that matched, so an ordinary entry pays nothing for it.
// The full rule is task_guidance.repeat_signal (fuli://rules/task-entry/task_guidance).
export const REPEAT_GUIDANCE = 'The user may be saying they already asked for this (task_guidance.repeat_signal). '
  + 'If the message is not actually about something they said or did before, treat it as an ordinary message: keep nothing, ask nothing. '
  + 'Otherwise check whether FULI already holds it (effective_preferences, task_knowledge_recall): if so store nothing new and say in one line why it did not apply '
  + '(not delivered, wrong scope, or delivered and not followed; the last also in the checkpoint workLog). '
  + 'If not, keep it this turn with checkpoint_task_knowledge remember, quoting their words (scope unsure when this project vs everywhere is unclear), '
  + 'and say in one line it is kept as an item waiting for their confirmation, never that it is remembered. Ask, with clickable choices, only when what to keep is unclear.';
