// rec#63 step 2: the synthetic recall world the usage prior is measured on.
// Generated from a seed, so every run sees the same world; nothing is a sample
// of real FULI knowledge. Each query has candidates the Provider returns with a
// score that is only loosely tied to relevance (lexical collisions put
// irrelevant items high), a relevance grade (3 direct answer, 1 related, 0
// irrelevant) and the chance that an Agent shown the item reports using it.
//
// Query kinds:
// - plain: two direct answers, two related items, three irrelevant ones;
// - stale_version: the old version of the answer is still current in the
//   graph (not superseded), scores high and is rarely used once the new one
//   sits beside it;
// - quiet_relevant: a direct answer Agents use without reporting it, so the
//   prior wrongly reads it as unused (the harm case);
// - hub: irrelevant "hub" items (a general runbook) match many queries; one hub
//   is the direct answer of exactly one query, where its low use elsewhere
//   counts against it (the second harm case);
// - cold_start: a direct answer that first exists after the history, so it was
//   never shown; it must not be buried by items that were.
export const USE_CHANCE = Object.freeze({ 3: 0.6, 1: 0.15, 0: 0.03 });
const QUIET_USE_CHANCE = 0.08;
const STALE_USE_CHANCE = 0.1;
const HUBS = 6;
const KINDS = ['plain', 'plain', 'stale_version', 'quiet_relevant', 'hub', 'cold_start'];

export function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildWorld({ seed = 63, queries: queryCount = 30 } = {}) {
  const random = mulberry32(seed);
  const between = (low, high) => Math.round((low + (high - low) * random()) * 1000) / 1000;
  const hubs = Array.from({ length: HUBS }, (_, index) => ({ id: `hub-${index + 1}`, score: between(0.6, 0.9) }));
  const queries = [];
  for (let index = 0; index < queryCount; index += 1) {
    const kind = KINDS[index % KINDS.length];
    const id = `q${String(index + 1).padStart(2, '0')}`;
    const item = (suffix, grade, low, high, extra = {}) => ({ id: `${id}-${suffix}`, grade, score: between(low, high),
      useChance: USE_CHANCE[grade], ...extra });
    const candidates = [
      item('answer-a', 3, 0.45, 0.85), item('answer-b', 3, 0.45, 0.85),
      item('related-a', 1, 0.4, 0.8), item('related-b', 1, 0.4, 0.8),
      item('noise-a', 0, 0.4, 0.9), item('noise-b', 0, 0.4, 0.9), item('noise-c', 0, 0.4, 0.9)
    ];
    if (kind === 'stale_version') candidates.push(item('answer-a-old', 0, 0.8, 0.92, { useChance: STALE_USE_CHANCE, stale: true }));
    if (kind === 'quiet_relevant') candidates[1] = { ...candidates[1], useChance: QUIET_USE_CHANCE, quiet: true };
    // Two hubs reach every query; the hub query makes the first of them its direct answer.
    const reached = [hubs[index % HUBS], hubs[(index + 1) % HUBS]];
    for (const hub of reached) {
      const answers = kind === 'hub' && hub === reached[0];
      candidates.push({ id: hub.id, grade: answers ? 3 : 0, score: hub.score, useChance: USE_CHANCE[answers ? 3 : 0],
        hub: true });
    }
    const late = kind === 'cold_start' ? [item('answer-new', 3, 0.5, 0.7, { coldStart: true })] : [];
    queries.push({ id, kind, candidates, late });
  }
  return { seed, queries };
}
