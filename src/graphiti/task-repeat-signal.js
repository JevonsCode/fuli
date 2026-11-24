import { personWords } from '../conversations/person-words.js';
import { withoutFuliMarkup } from './fuli-markup.js';

// "I already told you, why don't you …" (Jevons 11-24). A person who has to
// say a thing again is telling FULI it should have been kept: an Agent that
// only apologises and complies makes the same mistake in the next session.
//
// Model-free, and only a candidate: the Agent reading the entry decides
// whether the person really says it was asked for before (REPEAT_GUIDANCE),
// and a candidate it ignores costs one paragraph, never the turn's automatic
// close (task-context-entry.js). So the shape of the sentence decides, never
// a list of verbs (three rounds of verb lists kept missing what people say):
// - only the person's own words count: host markup, quoted text, code, log
//   lines and what someone else said or wrote (「PM 说：…」, "The customer
//   wrote: …") are taken out first;
// - a sentence that talks about such a phrase rather than saying it (如果,
//   帮我写, 匹配, regex, "write a test") is skipped;
// - a candidate needs both halves in one sentence or two neighbouring ones:
//   the speaker (我, or no subject but 跟你/给你/让你/告诉你) saying they did
//   or said it before (PRIOR), and the Agent being asked why it does not, or
//   told it still or again does (FAILED); whatever verb follows 不/没/还/又;
// - a few fixed phrases are both halves at once (「说了多少遍」「不是跟你说过
//   吗」「你又…」, "I told you", "how many times").
const QUOTED = /"[^"\n]*"|“[^”\n]*”|「[^」\n]*」|『[^』\n]*』|‘[^’\n]*’|```[\s\S]*?```|`[^`\n]*`/gu;
const LOG_LINE = /^\s*(?:\[?\d{4}-\d{2}-\d{2}|\[?\d{1,2}:\d{2}:\d{2}|\[?(?:ERROR|WARN(?:ING)?|INFO|DEBUG|TRACE|FATAL)\b)/u;
// What follows a label or someone else's words is theirs, to the end of the line.
const LABEL = /(?:日志|工单|报错|报告|反馈|原文|截图|输出|\b(?:logs?|error|output|ticket|report|transcript))\s*[:：]/iu;
const REPORTED = /([^\s，。！？,.!?:：]{1,12}?)\s*(?:说|问|写道|写着|反馈|回复|留言|提到|评论)(?:我|你)?\s*[:：]/u;
// Someone else, named by a role: 「老板：…」 is theirs, 「他为什么还不改」 is not about the Agent.
const OTHERS = '(?:老板|领导|经理|产品经理|产品|PM|用户|客户|客服|同事|对方|甲方|老师|面试官|他们|她们|他|她|它)';
const OTHER_SPEAKING = new RegExp(`^\\s*${OTHERS}\\s*[:：]`, 'u');
const REPORTED_EN = /(?<!['’])\b(\w+)\s+(?:said|says|wrote|writes|asked|asks|replied|commented)(?:\s+\w+){0,2}\s*:/iu;
const ABOUT_THE_WORDS = /如果|假如|假设|帮我写|写个|写一个|匹配|正则|例如|比如|\bif I\b|\bregex\b|\bwrite (?:a|an|me a) (?:test|regex|example|pattern)|\bfor example\b/iu;
const SENTENCES = /(?<=[。！？!?])|(?<=\.)\s+|\r?\n/u;

// 我 as the one speaking, not 跟我/让我/给我 (someone else to me).
const I = '(?<![让叫给跟和帮替对把被向问])我们?';
// Where a clause starts: a subject-less 「早就跟你讲过」 is the person's, 「他已经跟你说过」 is not.
const CLAUSE = '(?:^|[，,；;：:]\\s*)';
const BEFORE = '(?:已经|都|早就?|明明|之前|先前|上次|上回|前面|刚才?|昨天)';
const PRIOR = [
  // 「我已经…」「我明明…」「我都…」「我刚…」「我说过…」「我提醒过你」「我说了…」
  new RegExp(`${I}[^，,。！？!?；;\\n]{0,10}?(?:${BEFORE}|过(?=[你了，,\\s]|$)|(?:说|讲|告诉你|交代|强调|提醒你?)了|不是)`, 'u'),
  // No subject: 「早就跟你讲过」「之前让你…」「跟你说了…」「给你发过…」「不是说…」
  new RegExp(`${CLAUSE}(?:${BEFORE}\\s*)+(?:(?:跟|和|给|让|叫)你|告诉(?:过)?你)`, 'u'),
  new RegExp(`${CLAUSE}(?:(?:跟|和|给|让|叫)你|告诉你)[^，,。！？!?；;\\n]{0,16}?(?:过|了)`, 'u'),
  new RegExp(`${CLAUSE}(?:${BEFORE}\\s*)*不是(?:说|讲|让你|叫你|跟你|和你|告诉)`, 'u'),
  /\bI(?:'ve|'d| have| had)?\s+(?:already|told you|said|asked you|mentioned|explained)\b/iu,
  // 又 is "again" only when it is the Agent's: 「你怎么又用 npm」「又把 .env 提交了」「又给我加了」,
  // "you … again"; 「怎么又报错了」 reports a fault, and a bare 「咋又用 npm 了」 is not heard.
  new RegExp(`你们?[^，,。！？!?；;\\n]{0,6}?又|又(?:把|给我)`, 'u'),
  /\b(?:as|like) I (?:said|mentioned|told you)\b|\bdidn'?t I\b|\byou\b[^.!?\n]{0,40}\bagain\b/iu
];
// A plain 「我之前/前面/昨天…说过/交代/强调/约定/让你」 (or with no subject, 「之前强调过」): then the
// other half needs no 不/没/还/又 question; a 你 asked why or a 又 next to it is enough
// (「…，你为啥去改 test」「…，今天又是英文」「又把 .env 提交了，之前强调过的」).
const SAID_BEFORE = new RegExp(`(?:${I}|${CLAUSE})(?:${BEFORE}|上周|前天)[^，,。！？!?；;\\n]{0,8}?`
  + '(?:(?:说|讲)(?:过|了|好)|交代|交待|强调|约定|要求|提醒|告诉|(?:让|叫)你)', 'u');
const PUT_TO_THE_AGENT = [
  new RegExp(`(?<!${OTHERS})你们?[^，,。！？!?；;\\n]{0,4}?(?:为什么|为啥|为何|干嘛|干吗|怎么|咋)(?!看|想|样|办|说)`, 'u'),
  new RegExp(`(?<!${OTHERS})又(?!不是|没错)`, 'u')
];
const FAILED = [
  // 「为什么你不…」「你为什么还…」「为啥不…」「你咋还是不…」「怎么又…」, 你 or not
  // (a few words between: 「你怎么一个都没遵守」; never 「为什么你的脚本还是报错」 or 「他为什么还不改」)
  new RegExp(`(?<!${OTHERS})(?:你们?|您)?(?:为什么|为啥|为何|怎么|咋|干嘛|干吗)(?:(?!${OTHERS})[^，,。！？!?；;的\\w\\s]){0,4}?(?:不|没|还|又)`, 'u'),
  // 「你还按旧的来」「你又加了」, not 「你还好吗」「你又不是人」
  /你们?(?:就|也)?(?:还是|还在|还|又|老是|总是|仍然|依然|照样|偏偏)(?!好|行|在吗|有|没错|不是|来了)/u,
  /还是(?:不|没)/u,
  /\bwhy\s+(?:do|does|did|are|is|were|was|would|will|have|has|can|could)(?:n'?t| not)?\s+(?:you|it)\b/iu,
  /\byou(?:'re| are)? still\b|\byet you\b|\bbut you (?:still|did(?:n'?t| not)|keep|never)\b|\byou\b[^.!?\n]{0,40}\bagain\b/iu
];
// 「我说过别用 any 吗？」: the person asking themselves, unless it is said to the
// Agent (跟你/让你) or the next sentence is the complaint (「…吗？你怎么还用」).
const ASKING_THEMSELVES = /^我(?!.*不是).*吗[？?]?$/u;
const TO_THE_AGENT = /(?:跟|和|让|给)你/u;
const BOTH_AT_ONCE = [
  // 「我已经说过了」「我早就讲过了」
  new RegExp(`${I}${BEFORE}*(?:说|讲|强调|交代)过了`, 'u'),
  // 「我说过别用 any」「我早就讲了，别动 lockfile」 (「我之前说过要用 Redis，但…」 is a plan changing)
  new RegExp(`${I}${BEFORE}*(?:说|讲|强调|交代|要求)(?:过|了)?[，,]?\\s*(?:别|不要|不许|不准|一定要)`, 'u'),
  // 「我跟你说过…」「早就跟你讲过」, not 「上次跟你说过的那个方案」
  new RegExp(`(?:${I}|${CLAUSE})${BEFORE}*(?:跟|和)你(?:说|讲|提)(?:过|了)(?!的)`, 'u'),
  new RegExp(`${I}${BEFORE}+(?:让|叫|要)你(?:别|不要|不许)`, 'u'),
  // 「之前不是让你用 pnpm 吗」「我不是让你先跑 lint 吗」「不是跟你说过了」
  new RegExp(`(?:${CLAUSE}|${I})${BEFORE}*不是(?:让你|叫你|跟你说|跟你讲|和你说|说过|讲过|说了|讲了)[^。！？!?\\n]{0,30}吗`, 'u'),
  new RegExp(`(?:${CLAUSE}|${I})${BEFORE}*不是(?:跟你|和你)(?:说|讲)(?:过|了)`, 'u'),
  // 「都说了别用 any」「说好的不要加注释呢」「上次不是说好了」「上次就说过」
  new RegExp(`(?:${CLAUSE}|${I})都说了[，,]?\\s*(?:别|不要|不许|不准|让你|多少)`, 'u'),
  /说好的[^。！？!?\n]{1,30}呢/u,
  /(?:上次|上回|之前|前面|刚才|昨天)不是说好了/u,
  new RegExp(`(?:${CLAUSE}|${I})(?:上次|上回|之前|刚才|前面)就(?:跟你)?(?:说|讲|提|强调)(?:过|了)`, 'u'),
  // 「说了多少遍了」「跟你讲了多少回了」「我都说了三遍了」; not 「他已经说了好几次了」「我讲了两遍课」
  new RegExp(`(?:${CLAUSE}|${I})(?:都|已经|早就?)?(?:跟你|和你)?(?:说|讲|提|强调)(?:了|过)`
    + '(?:多少|好几|很多|无数|[两二三四五六七八九十百千万\\d]+)(?:遍|次|回)(?=了|[，,。！!？?]|$)', 'u'),
  // The Agent doing it again: 「你又把测试删了」「你怎么又…」「又忘了」, not 「你又不是人」「你又没错」
  /你们?(?:怎么|咋)?(?:又|老是|总是)(?!不是|没错|没有错|来了)/u,
  /又忘了|怎么又忘|(?:老是|总是)忘/u,
  /上次你就是这么/u,
  /第[二三四五六七八九十几\d]+次了[，,]?\s*(?:别|不要|还|你)/u,
  /(?:^|你)又来了[，,]\s*(?:还是|又)/u,
  // English
  /\bI(?:'ve| have)? (?:already )?told you\b/iu,
  /\bI said no\b/iu,
  /\bI(?:'ve| have) said (?:this|that|it) (?:before|already|twice|again)\b/iu,
  /\bI (?:already )?(?:mentioned|said) (?:it|this|that) (?:already|before|twice)\b/iu,
  /\bI (?:already )?asked you (?:before|already|twice|to)\b/iu,
  /\b(?:as|like) I (?:said|mentioned|told you)(?: (?:before|earlier|last time|already))?[,:]/iu,
  /\bdidn'?t I (?:say|tell you|ask you|mention)\b/iu,
  /\bhow many times (?:do|have|must|did) (?:I|you)\b/iu,
  /\byou (?:keep|kept) (?:forgetting|ignoring)\b/iu,
  /\bwe(?:'ve| have)? (?:already )?(?:talked|discussed|been over) (?:about )?(?:this|that)\b/iu,
  /(?:^|[.!?]\s+)again,\s/iu
];

// The person's own sentences, with what is not theirs taken out.
export function ownSentences(prompt) {
  const own = withoutFuliMarkup(personWords(prompt));
  if (!own) return [];
  return own.replace(QUOTED, ' ').split(/\r?\n/u)
    .filter(line => !LOG_LINE.test(line) && !OTHER_SPEAKING.test(line))
    .map(line => cutAt(cutAt(cutAt(line, LABEL), REPORTED, speaker => !/[我你]$/u.test(speaker)),
      REPORTED_EN, speaker => !/^(?:I|you|we)$/iu.test(speaker)))
    .join('\n').split(SENTENCES).map(sentence => sentence.trim()).filter(Boolean);
}

function cutAt(line, pattern, applies = () => true) {
  const match = pattern.exec(line);
  return match && applies(match[1] ?? '') ? line.slice(0, match.index) : line;
}

// True when the person may be saying they asked for this before: a candidate
// for the Agent to judge, never a finding (REPEAT_GUIDANCE).
export function repeatComplaint(prompt) {
  const sentences = ownSentences(prompt).filter(sentence => !ABOUT_THE_WORDS.test(sentence));
  const failed = sentences.map(sentence => FAILED.some(pattern => pattern.test(sentence)));
  return sentences.some((sentence, at) => {
    if (ASKING_THEMSELVES.test(sentence) && !TO_THE_AGENT.test(sentence) && !failed[at + 1]) return false;
    if (BOTH_AT_ONCE.some(pattern => pattern.test(sentence))) return true;
    const near = [sentences[at - 1], sentence, sentences[at + 1]].filter(Boolean);
    if (SAID_BEFORE.test(sentence) && near.some(text => PUT_TO_THE_AGENT.some(pattern => pattern.test(text)))) return true;
    return PRIOR.some(pattern => pattern.test(sentence)) && (failed[at - 1] || failed[at] || failed[at + 1]);
  });
}

// Sent only on a turn that matched, so an ordinary entry pays nothing for it.
// It opens with the judgement the match leaves to the Agent; only what to do
// follows. Why, and the wording, are the rule's alone: task_guidance.repeat_signal.
export const REPEAT_GUIDANCE = 'Maybe they told you this before and you did not follow it. Judge that first; '
  + 'if not, ignore this, do nothing. If so (rule: task_guidance.repeat_signal): if FULI holds it, store nothing; '
  + 'say in one line why it did not apply (not delivered, wrong scope, or not followed: that one also in the workLog). '
  + 'Else checkpoint_task_knowledge remember, their words as quote, scope unsure if unclear; say it awaits their '
  + 'confirmation, never that it is remembered. Ask, with clickable choices, only if what to keep is unclear.';
