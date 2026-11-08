// FULI's own markup inside text that is about to become knowledge. A reply or
// prompt can carry what FULI put there: the source marker a recall asks the
// Agent to lead with (source-marker.js), the 「FULI 来源 · N 条」 list, the
// identity and turn receipts (identity-receipt.js, turn-receipt.js), a
// delegation receipt, and links to FULI's own items. Kept as knowledge, each
// capture wrapped the last one's link and the review queue filled with nested
// links to other pending items (seen 2026-11-08). This returns the text with
// all of that removed: a line that is only FULI markup goes, a link to a FULI
// page inside a sentence keeps its words and loses the link.
const LOOPBACK = String.raw`https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?`;
// A FULI page: any fuli:// link; on the console, a knowledge item or a turn's
// records, in the shapes FULI writes them (a project's own localhost pages stay).
const SEGMENT = String.raw`[^/\s<>()?#]+`;
const ITEM_KIND = '(?:entity|relationship)';
const FULI_URL = String.raw`(?:fuli:\/\/[^\s<>()]+|${LOOPBACK}\/knowledge\/(?:${SEGMENT}\/${SEGMENT}\/directory\/${ITEM_KIND}|item\/${SEGMENT}\/${ITEM_KIND}|turn\/${SEGMENT}\?episodes=)[^\s<>()]*)`;
const LABEL = String.raw`\[((?:\\.|[^\]\\])*)\]`;
const FULI_LINK = new RegExp(String.raw`${LABEL}\(<?${FULI_URL}>?\)`, 'gu');
const BARE_FULI_URL = new RegExp(String.raw`<?${FULI_URL}>?`, 'gu');
const SOURCE_MARKER = new RegExp(String.raw`\*{0,2}${LABEL}\(<?${LOOPBACK}[^\s<>()]*>?\)\*{0,2}`, 'gu');
const MARKER_LABEL = /^(?:🌠|◇)\s*FULI\s*·/u;
const ONLY_LINKS = new RegExp(String.raw`^[\s>*•·,，、;；:：-]*(?:${LABEL}\(<?${FULI_URL}>?\)[\s*•·,，、;；:：-]*)+$`, 'u');
const MARKUP_LINES = [
  /^\s*\*{0,2}FULI 来源 · \d+ 条\*{0,2}\s*$/u,
  /^\s*[-*•]?\s*另有 \d+ 条命中/u,
  /FULI Agent：/u,
  /^\s*FULI [本上]轮沉淀(?:（补发）)? \d+ 条/u,
  /^\s*另 \d+ 条未列出：/u,
  /^\s*[-*•]\s*(?:新增|更新)\s.*｜.*\]\(<?(?:fuli:|https?:)/u,
  /^\s*🤝 已(?:代你操作|按你的原话记下)/u
];

export function withoutFuliMarkup(text) {
  if (typeof text !== 'string') return '';
  return tidy(text.split(/\r?\n/u)
    .filter(line => !MARKUP_LINES.some(pattern => pattern.test(line)) && !ONLY_LINKS.test(line))
    .map(line => line
      .replace(SOURCE_MARKER, (marker, label) => (MARKER_LABEL.test(label) ? '' : marker))
      .replace(FULI_LINK, (link, label) => plainLabel(label))
      .replace(BARE_FULI_URL, ''))
    .join('\n'));
}

// Whether text carries any of that markup. Knowledge kept before #839 still
// can (reply-echo.js); anything captured since has none.
export function hasFuliMarkup(text) {
  return typeof text === 'string' && Boolean(text.trim()) && withoutFuliMarkup(text) !== tidy(text);
}

function tidy(text) {
  return text.split(/\r?\n/u).map(line => line.replace(/[ \t]+$/u, '')).join('\n').replace(/\n{3,}/gu, '\n\n').trim();
}

// Why a captured field that held nothing but FULI's markup is refused.
export const ONLY_MARKUP = field => `${field} holds only FULI's own markup (a source marker, receipt or link to a FULI item); state the approach or fact itself`;

// A link's words as written before source-marker.js escaped them for Markdown.
function plainLabel(label) {
  return label.replace(/\\([\\[\]])/gu, '$1')
    .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&').trim();
}
