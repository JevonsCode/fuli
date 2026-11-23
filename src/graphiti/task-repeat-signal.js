import { personWords } from '../conversations/person-words.js';
import { withoutFuliMarkup } from './fuli-markup.js';

// "I already told you, why don't you …" (Jevons 11-24). A person who has to
// say a thing again is telling FULI it should have been kept: an Agent that
// only apologises and complies makes the same mistake in the next session.
// Read on the person's own words only, model-free, and on purpose narrow:
// a missed signal costs one more reminder, a false one costs every ordinary
// technical question ("why not use X here?") a forced checkpoint. So each
// pattern needs the person to say that THEY said it before, or that the
// Agent did it AGAIN; "why", "already" or "last time" alone never match.
const REPEAT_PATTERNS = [
  // 「我已经说过了」「我早就讲了」「我都已经强调过」
  /我(?:都|早就?|明明)?已经(?:说|讲|告诉(?:过)?你|提|强调|要求|交代|写)(?:过|了)/u,
  /我(?:都|早就?|明明)(?:说|讲|告诉(?:过)?你|提|强调|要求|交代)(?:过|了)/u,
  // 「我说过」 but not 「我说了算」「我写了一个函数」: bare only with 过, and only for saying
  /我(?:说|讲|强调|交代|告诉你)过/u,
  // 「我已经把端口改了，为什么你还不用」: what I did, then why YOU did not
  /我(?:都|早就?|明明)?已经[^。！？!?\n]{1,40}?了[^。！？!?\n]{0,12}?(?:为什么|为啥|怎么)你(?:还|又|就|都)?(?:不|没)/u,
  // 「上次就说过」「之前不是讲过了吗」「跟你说过多少遍」
  /(?:上次|上回|之前|以前|刚才|前面)(?:就|已经|不是|明明)?(?:跟你|和你|给你)?(?:说|讲|提|告诉你|交代|强调)(?:过|了)/u,
  /不是(?:跟你|和你)?(?:说|讲|告诉你|提|交代)(?:过|了)/u,
  /(?:说|讲|提|强调)(?:了|过)(?:多少|好几|很多|几|N)(?:遍|次)/u,
  /(?:跟|和)你(?:说|讲)过/u,
  // 「怎么又忘了」「怎么又用 npm 了」: the Agent repeating, not the system failing
  /怎么(?:又|还)(?:忘|没|不|这样|犯|用|改回|写成)/u,
  /又忘了/u,
  // English: "I already told you", "I've said this before", "as I said earlier"
  /\bI(?:'ve| have)? already (?:told|said|asked|mentioned|explained)\b/iu,
  /\bI(?:'ve| have) (?:told|said|asked|mentioned) (?:you )?(?:this|that|it) (?:before|already|twice|again)\b/iu,
  /\b(?:as|like) I (?:said|told you|mentioned) (?:before|earlier|last time)\b/iu,
  /\bdidn'?t I (?:say|tell you|ask|mention)\b/iu,
  /\bhow many times (?:do|have|must) I\b/iu,
  /\bI already [^.!?\n]{1,60}?\bwhy (?:didn'?t|don'?t|did not|do not|won'?t|aren'?t) you\b/iu,
  /\byou (?:keep|kept) (?:forgetting|ignoring|doing|using)\b/iu,
  /\b(?:you )?forgot (?:again|this again)\b/iu
];

// True when the person says they already asked for this; the sentence is the evidence.
export function repeatComplaint(prompt) {
  const own = withoutFuliMarkup(personWords(prompt));
  return Boolean(own) && REPEAT_PATTERNS.some(pattern => pattern.test(own));
}

// Sent only on a turn that matched, so an ordinary entry pays nothing for it.
// The full rule is task_guidance.repeat_signal (fuli://rules/task-entry/task_guidance).
export const REPEAT_GUIDANCE = 'The user says they already asked for this: treat it as a keep signal (task_guidance.repeat_signal). '
  + 'First check whether FULI already holds it (effective_preferences, task_knowledge_recall); if so do not store it again, '
  + 'tell them in one line why it did not apply (not delivered, wrong scope, or delivered and not followed) and put the last case in the checkpoint workLog. '
  + 'Otherwise, when what and where are clear, keep it this turn with checkpoint_task_knowledge remember, quoting their words, and say in one line what you kept and where it applies; '
  + 'when unsure, ask once with clickable choices (this project / everywhere / do not keep).';
