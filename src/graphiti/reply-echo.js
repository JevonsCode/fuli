import { hasFuliMarkup, withoutFuliMarkup } from './fuli-markup.js';

// An Agent's own reply that FULI kept as knowledge by mistake (before #839).
// The Stop hook kept one sentence of the reply as a pending experience, and a
// reply carries FULI's markup, so 待决策 filled with items like 「I moved the
// notice off the top bar; the fix is in PR #842, not merged yet.」. #839 stops
// new ones; this finds the old ones still waiting, so the person can drop them
// together. It only reads; dropping is the person's (reply-echo-group.js).
//
// Conservative: an item is one only when two signals agree, or when nothing
// but FULI's own markup is left of it. The person's own words never are: a
// preference, an item the person edited, or one a person proposed.

export const REPLY_ECHO_SIGNALS = Object.freeze(['reply_capture', 'fuli_markup', 'progress_narration', 'status_report', 'report_shape']);

const EXPERIENCE = 'ReusableExperience';
const CHECKPOINT_SOURCE = 'task_experience';
// The reply rule cut the sentence at this many characters for the title.
const TITLE_LIMIT = 240;

// 「I moved …」「We've fixed …」「我已经把 …」: the Agent telling what it did, in the
// past tense (「we run the migrations first」 is a convention, not narration).
const DONE = 'moved|fixed|added|updated|opened|merged|changed|ran|built|removed|made|wrote|created|pushed|committed|checked|verified|tested|implemented|renamed|replaced|reverted|restarted|split|landed|shipped|found|traced|confirmed|rebased|deleted|dropped|switched|started|stopped|posted|reviewed|measured';
const NARRATION = [
  new RegExp(String.raw`(?:^|[.;:!?]\s+|\n\s*(?:[-*•>]\s*)?)(?:I|We)(?:'ve|’ve|\s+have|\s+just|\s+also|\s+then|\s+now|\s+already|\s+first)*\s+(?:${DONE})\b`, 'iu'),
  /(?:^|[。；！？\n]\s*(?:[-*•>]\s*)?)我(?:已经?|刚刚?|先|把|这[次轮]|又)/u,
  /(?:^|[。；！？\n]\s*(?:[-*•>]\s*)?)(?:已经?|刚刚?)(?:把|修复|合并|提交|推送|完成|改好|改成|加上|移到|拆成|开了)/u
];
// A PR and where it stands, or a check run's outcome.
const STATUS = [
  /\bPR\s*#\d+|\/pull\/\d+\b|\bpull request #?\d+/iu,
  /\bnot (?:yet )?merged\b|\b(?:is|was|got|been) merged\b|\bCI (?:is |was )?(?:green|red|passing|failing|running)\b|\bchecks? (?:passed|are green|went green)\b|\btests? (?:passed|are green|all pass)\b/iu,
  /未合并|还没合并?|已合并|已经合并|CI\s*(?:全?绿|通过|挂了)|测试(?:已?通过|全过|全绿)|已提交|已推送/u
];
// A markdown status report: a heading, or checklist and status-mark lines.
const REPORT_LINE = /^\s*(?:#{1,6}\s+\S|[-*•]\s*\[[ xX]\]|(?:✅|❌|🟥|🟩|⚠️)\s*\S|\*\*(?:Status|Summary|Done|Next|状态|结果|总结|进展)\*\*)/u;

// The signals of one current item from the Provider's graph read (a node or
// an edge as /api/graph returns it), or null when it is not a reply echo.
export function replyEchoSignals(item, itemKind = 'entity') {
  if (!waitsForPerson(item)) return null;
  const text = itemText(item, itemKind);
  if (!text) return null;
  const signals = new Set();
  if (itemKind === 'entity' && replyCapture(item)) signals.add('reply_capture');
  const markup = hasFuliMarkup(text);
  if (markup) signals.add('fuli_markup');
  if (NARRATION.some(pattern => pattern.test(text))) signals.add('progress_narration');
  if (STATUS.some(pattern => pattern.test(text))) signals.add('status_report');
  if (reportShape(text)) signals.add('report_shape');
  const only = markup && !withoutFuliMarkup(text);
  const agree = signals.size >= 2;
  return only || agree ? REPLY_ECHO_SIGNALS.filter(signal => signals.has(signal)) : null;
}

// Still current, still waiting for the person, and not the person's own.
function waitsForPerson(item) {
  if (!item || typeof item !== 'object' || item.invalid_at || item.replaced_by_item_id) return false;
  if ((item.confirmation_status ?? 'pending') !== 'pending') return false;
  if (item.profile_aspect || item.human_edited === true) return false;
  const proposer = item.confirmation_basis?.proposed_by?.kind;
  return !proposer || proposer === 'agent';
}

function itemText(item, itemKind) {
  const parts = itemKind === 'relationship' ? [item.fact]
    : [item.name, item.summary, item.attributes?.solution];
  return [...new Set(parts.filter(part => typeof part === 'string' && part.trim()).map(part => part.trim()))].join('\n');
}

// The shape the Stop hook's reply rule kept: a checkpoint experience whose
// solution is its title, one sentence of the reply in both.
function replyCapture(item) {
  if (item.type !== EXPERIENCE) return false;
  const title = typeof item.name === 'string' ? item.name.trim() : '';
  const solution = typeof item.attributes?.solution === 'string' ? item.attributes.solution.trim() : '';
  if (!title || !solution) return false;
  const same = solution === title || (title.length >= TITLE_LIMIT - 1 && solution.startsWith(title));
  const evidence = Array.isArray(item.evidence) ? item.evidence : [];
  return same && (!evidence.length || evidence.some(record => record?.source_kind === CHECKPOINT_SOURCE));
}

// A markdown heading, or at least two checklist or status-mark lines.
function reportShape(text) {
  const lines = text.split(/\r?\n/u).filter(line => REPORT_LINE.test(line));
  return lines.some(line => /^\s*#{1,6}\s/u.test(line)) || lines.length >= 2;
}
