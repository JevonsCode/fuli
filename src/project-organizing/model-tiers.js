// How strong a model is for organising knowledge, told from its name. The
// work is judgement (what repeats, what is stale, what contradicts), so a
// stronger model does it better; a weak one should only copy what files say.
//
// Only families whose tier is not in doubt are listed. A name that matches
// none is `unknown`: FULI says so and advises the strongest model at hand,
// instead of guessing.

// Checked in order: a small variant of a strong family is weak.
const TIERS = Object.freeze([
  { tier: 'weak', pattern: /haiku|mini|nano|lite|small|tiny|flash|:\d(\.\d+)?b\b|-\d(\.\d+)?b\b/i },
  { tier: 'strong', pattern: /opus|fable|mythos/i },
  { tier: 'medium', pattern: /sonnet/i }
]);

export const MODEL_TIERS = Object.freeze(['strong', 'medium', 'weak', 'unknown']);

export function modelTier(model) {
  if (typeof model !== 'string' || !model.trim()) return 'unknown';
  return TIERS.find(({ pattern }) => pattern.test(model))?.tier ?? 'unknown';
}

// What to tell the person before a run, for the Agent to pass on in their language.
const ADVICE = Object.freeze({
  strong: 'This model is strong: it can do the whole job (fill, merge, mark stale, tidy).',
  medium: 'This model is mid-range: it can do the whole job; a stronger model judges merges and contradictions better.',
  weak: 'This model is small: copy what files and records say, and do not merge or judge what is stale. Tell the person a stronger model organises better.',
  unknown: 'FULI does not know this model\'s strength. Organising is judgement, so tell the person the strongest model they have does it best.'
});

export const tierAdvice = tier => ADVICE[tier] ?? ADVICE.unknown;
