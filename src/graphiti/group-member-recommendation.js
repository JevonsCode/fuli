import { identityKey } from '../text/name-identity.js';
import { termOccurs } from '../standing-assignments/term-match.js';

// Which of the person's FLAs fit a discussion question (rec#55), without a
// model: a standing assignment whose confirmed terms the question carries
// names its lead first; then an FLA whose occupation, responsibility or
// capabilities share a term with the question. Each recommendation says why
// in a few words. When too few fit, the remaining places go to the current
// project's FLAs and then the most recently active, said as such.

const STANDING = 4;
const OCCUPATION = 3;
const ROLE = 1;
const TERM_MINIMUM = 2;
const REASON_TERM_LIMIT = 12;
// Words nearly every responsibility carries; they say nothing about fit.
const GENERIC = new Set(['负责', '工作', '项目', '相关', '进行', '以及', '我们', '这个', '一个', 'and', 'the', 'for',
  'with', 'work', 'project', 'synthetic']);
const UNSPACED = /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}]/u;

// candidates: ranked, one per FLA, all able to take part. standing: the
// standing-assignment matches of the question ({ assignment, matchedTerms }).
export function recommendMembers(question, candidates, { count, standing = [], currentProjectId = null }) {
  const text = identityKey(question);
  const scored = candidates.map((item, order) => {
    const routed = standing.find(({ assignment }) => assignment.leadAgentId === item.agentId);
    if (routed) return { item, order, score: STANDING, note: `长期负责「${short(routed.matchedTerms?.[0] ?? routed.assignment.responsibility)}」` };
    const occupation = sharedTerm(text, item.occupation);
    if (occupation) return { item, order, score: OCCUPATION, note: `职业「${short(item.occupation)}」与问题相关` };
    const role = [item.responsibility, ...item.capabilities].map(value => sharedTerm(text, value)).find(Boolean);
    return role ? { item, order, score: ROLE, note: `职责涉及「${short(role)}」` } : { item, order, score: 0, note: null };
  });
  const fitting = scored.filter(entry => entry.score > 0).sort((a, b) => b.score - a.score || a.order - b.order);
  const rest = scored.filter(entry => entry.score === 0).map(entry => ({ ...entry,
    note: entry.item.projectId === currentProjectId ? '当前项目成员' : '最近活跃' }));
  return [...fitting, ...rest].slice(0, count).map(({ item, note }) => ({ ...item, note }));
}

// A term of value that the question carries: a whole word, or for scripts
// written without spaces any two-character run ("产品" of "产品经理").
function sharedTerm(question, value) {
  for (const word of identityKey(value ?? '').split(/[\s\p{P}\p{S}]+/u)) {
    const terms = UNSPACED.test(word) ? [...word].slice(0, -1).map((character, index) => character + [...word][index + 1])
      : [word];
    const found = terms.find(term => [...term].length >= TERM_MINIMUM && !GENERIC.has(term) && termOccurs(question, term));
    if (found) return found;
  }
  return null;
}

function short(value) {
  return [...String(value ?? '')].slice(0, REASON_TERM_LIMIT).join('');
}
