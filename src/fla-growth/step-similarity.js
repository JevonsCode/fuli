// When two pieces of an FLA's work are the same kind of work (Jevons 11-23).
// Step titles are free text an Agent writes anew each time ("Run the tests",
// "运行测试", "Run unit tests (npm test)"), so the same work never repeats word
// for word. Model-free and explainable instead:
// - a step is its words (Latin words, numbers as #) and its Chinese character
//   pairs, minus filler words;
// - two steps are alike when they share at least half of those (Jaccard ≥ 0.5);
// - two plans are alike when each has MIN_STEPS steps or more and at least 60%
//   of the longer plan's steps pair off with an alike step of the other, in any
//   order (Agents reorder and skip steps).
export const MIN_STEPS = 3;
const STEP_ALIKE = 0.5;
const PLAN_ALIKE = 0.6;
const FILLER = new Set(['the', 'a', 'an', 'to', 'of', 'and', 'for', 'in', 'on', 'with', 'into', 'from', 'by', 'it', 'this',
  'that', 'all', 'then', 'step']);

export function normalizedStep(title) {
  return String(title ?? '').toLowerCase().replace(/\d+(?:[.:]\d+)*/gu, '#')
    .replace(/[^\p{L}\p{N}#]+/gu, ' ').replace(/\s+/gu, ' ').trim();
}

function stepTokens(title) {
  const text = normalizedStep(title);
  const words = (text.match(/[a-z#]+/gu) ?? []).filter(word => !FILLER.has(word));
  const pairs = (text.match(/\p{Script=Han}+/gu) ?? [])
    .flatMap(run => run.length < 2 ? [run] : Array.from({ length: run.length - 1 }, (_, i) => run.slice(i, i + 2)));
  return new Set([...words, ...pairs]);
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}

export function stepsAlike(a, b) {
  return jaccard(stepTokens(a), stepTokens(b)) >= STEP_ALIKE;
}

export function plansAlike(a, b) {
  if (a.length < MIN_STEPS || b.length < MIN_STEPS) return false;
  const left = a.map(stepTokens);
  const right = b.map(stepTokens);
  const used = new Set();
  let paired = 0;
  for (const step of left) {
    const match = right.findIndex((other, index) => !used.has(index) && jaccard(step, other) >= STEP_ALIKE);
    if (match >= 0) { used.add(match); paired += 1; }
  }
  return paired / Math.max(a.length, b.length) >= PLAN_ALIKE;
}
