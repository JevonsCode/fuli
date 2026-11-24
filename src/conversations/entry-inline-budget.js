import { copyPreferenceScope, entryWorkKind, heldOwes, heldStatus } from './preference-snapshot.js';
import { preferenceAlwaysInline, preferenceNamesWorkKind, preferenceSceneReplaceable } from '../graphiti/preference-task-scope.js';
import { blockedByDeliveryBudget, blockedPreferenceDelivery, taskPreferenceRead } from '../mcp/preference-delivery.js';
import { managerRead, memoryRead, teamRead } from './entry-detail-readers.js';
import { basename } from 'node:path';
import { generatedPreferenceKey, preferenceIndex, statedScopeMeetsProject } from './preference-index.js';
import { withDeliveredHabits } from './entry-habits-line.js';

// The blocked reason of an entry that does not fit its host's inline limit.
const INLINE_BUDGET = 'inline_budget';

// A task entry bounded to the inline limit of the host that shows it (rec#11
// D-54). An Agent adapter whose host keeps only a preview of a longer hook
// context passes its limit; every other entry is delivered as it is.
export const OMITTED_PREFERENCES_LABEL = 'More preferences apply than this entry lists (preferences_omitted): '
  + 'read them with its read call before acting where one may apply.';
// Added when the omission names every left-out item (preferences_omitted.index,
// rec#137): one line each, so the model expands what may apply instead of
// paging the whole revision to find out what exists.
export const OMITTED_INDEX_LABEL = 'preferences_omitted.index (or earlier: index_unchanged + index_added) names each: '
  + 'read the ones this task may touch by key (read_task_preferences keys).';
// Added when hard rules are among them (D-69). A delta repeats it every turn,
// so it asks for one read, not one per turn.
export const ALWAYS_INLINE_OMITTED_LABEL = 'Hard rules are among them (preferences_omitted.includes_always_inline): '
  + 'if they are not already in this conversation, read the omitted ones once with read_task_preferences before acting; '
  + 'they stay in force.';

// Instead of the sentences above when the task's reader cannot serve them
// (no read named, rec#128): nothing points at a read that would be refused.
export const OMITTED_UNREADABLE_LABEL = 'More preferences or conflicts apply than this entry lists (preferences_omitted, '
  + 'active_conflicts_omitted) and this task cannot read them: before acting where one may apply, tell the person and ask.';

// Added when the active conflicts are left out (D-72).
export const OMITTED_CONFLICTS_LABEL = 'Unresolved preference conflicts apply that this entry does not list (active_conflicts_omitted): '
  + 'read them with read_task_preferences before acting where one may apply, and apply no alternative until it is resolved.';

// The sentences that say what a frame leaves out (preferences_omitted,
// active_conflicts_omitted), or null where it leaves nothing out: a hook puts
// them after its label (preference-lifecycle.js), an MCP answer in a field
// beside them (mcp/task-entry-budget.js).
export function omittedSentences(projected) {
  const omitted = projected?.preferences_omitted, conflicts = projected?.active_conflicts_omitted;
  if (!omitted && !conflicts) return null;
  if (!(omitted ?? conflicts).read) return [OMITTED_UNREADABLE_LABEL];
  return [...(omitted ? [OMITTED_PREFERENCES_LABEL] : []),
    ...(omitted?.index?.length || omitted?.index_unchanged ? [OMITTED_INDEX_LABEL] : []),
    ...(omitted?.includes_always_inline ? [ALWAYS_INLINE_OMITTED_LABEL] : []), ...(conflicts ? [OMITTED_CONFLICTS_LABEL] : [])];
}

// The entry with only its hard rules spelled out and the rest counted with
// their read, as a bounded frame counts them; the entry as it is where every
// preference is a hard rule. For a caller that already holds the rest
// (an MCP answer whose revision it named, mcp/task-entry-budget.js).
export function hardRulesOnly(value) {
  const preferences = Array.isArray(value?.effective_preferences) ? value.effective_preferences : [];
  const kept = new Set(preferences.flatMap((item, index) => preferenceAlwaysInline(item) ? [index] : []));
  return kept.size === preferences.length ? value : withPreferences(withoutPreferenceIds(value), kept, preferences.length, false);
}

// The default: the entry as it is.
export const WHOLE_ENTRY = (value, { deliver }) => deliver(value);

// For a path without a session cache: every candidate is delivered as it is.
export function fitUncached(fit, value, render) {
  const attempt = candidate => ({ candidate, result: render(candidate) });
  return fit(value, { deliver: attempt, complete: attempt }).result;
}

// A fit for an inline limit of `limit`, measured by `length(result)`. The
// delivery passes `deliver(candidate)`, the frame this session would actually
// get (a delta where one applies), and `complete(candidate)`, its complete
// frame. The answer is always one `deliver` made.
//
// An entry that fits is unchanged. Otherwise, in this order:
// 1. the automatic recall becomes a pointer to its search, then the recent
//    conversation drops its oldest messages, as the Provider's own window does;
//    where that is not enough, the preferences lose their IDs first and step
//    1 is tried again;
// 2. then preferences go, lowest ranked first, except hard rules
//    (preferenceAlwaysInline), which are always listed. The rest rank by
//    stated scope, kind and task scene: an item whose prose-stated scope the
//    session's project does not meet last, then a boundary a scene switch
//    never revokes first, then an item whose own scene key names the task's
//    work kind, then human-confirmed before agent-confirmed, then the
//    Provider's order. The preferences always get at least half the limit
//    (PREFERENCE_SHARE, a floor and never a cap): the recall and the
//    conversation give way to that floor first, and the room they leave goes
//    to more preferences (sharedFit). The first frame of a generation or a
//    scope chooses the set; a later frame (`held`, what its base frame spelled
//    out) never lists fewer while that fits beside the leanest context of
//    step 1, and adds more while the frame it delivers fits, up to what one
//    complete frame holds beside that leanest context (heldFit). What
//    is left out is named in
//    preferences_omitted.index where that fits, never at the cost of a hard
//    rule's body;
// 3. where even the hard rules do not fit beside the rest, the entry's details
//    give way to them, one at a time, each to a count or preview with its
//    reader (D-72, detailLevels): the working-memory previews (global layer
//    first; each keeps its revision), the directory snapshot, the team roster,
//    the managers' details and then the active conflicts. The role is never
//    cut. The ranked preferences are bounded beside the hard rules at the
//    first detail level where those fit;
// 4. then as much recall and conversation as still fits comes back, and each
//    reduced detail on its own while it fits, the last reduced first.
// What is left out is named by count with its reader. If the hard rules alone
// are still over the limit (D-69), they are bounded the same way, as the
// largest prefix by scope (Agent, project, global) and then the Provider's
// order, and the omission says so (includes_always_inline): past Claude
// Code's preview they were never seen. Closing fields and identity always
// stay. An entry that does not fit even so is never sent past the limit: it is
// the blocked frame (inline_budget) that keeps the token, closing fields and
// identity, lists the largest prefix of the same ranking that fits beside them
// with the rest counted, and recovers through read_task_preferences where the
// reader can serve the task (taskPreferenceRead).
// `projectPath`: the folder the session works in, which with the entry's own
// project ID and name is what a preference's prose-stated scope is read
// against (preference-index.js, rec#111).
// `measure`: the unit `limit` is in, as the preferences' floor counts a text
// (`length` counts the result in the same unit): UTF-16 code units unless the
// host counts otherwise (Codex counts UTF-8 bytes).
export function inlineEntryFit(limit, length, { projectPath = null, measure = textLength } = {}) {
  return boundedFit(limit, length, projectPath, true, measure);
}

const textLength = text => text.length;

// The search alone (steps 1 to 4 without the preferences' floor), as main
// bounds every entry. Only tests call it, as main's old path to measure a
// session's first frame against (it never spells out fewer bodies there);
// production code never does.
export function inlineSearchFit(limit, length, { projectPath = null } = {}) {
  return boundedFit(limit, length, projectPath, false, textLength);
}

function boundedFit(limit, length, projectPath, withFloor, measure) {
  return (whole, { deliver, complete, held = null }) => {
    // A frame the renderer blocked as over its own delivery budget is short,
    // but delivers nothing: it does not fit. Size only grows with the entry,
    // so both conditions stay monotonic for the search below. Any other
    // blocked reason is kept as it is.
    const fits = attempt => !blockedByDeliveryBudget(attempt.result.structuredContent) && length(attempt.result) <= limit;
    for (const level of contextLevels(whole)) {
      const attempt = deliver(level);
      if (fits(attempt)) return attempt;
    }
    // Preference IDs go before any preference does (rec#75): search finds
    // one by its preference_key.
    const value = withoutPreferenceIds(whole);
    const levels = contextLevels(value);
    for (const level of levels) {
      const attempt = deliver(level);
      if (fits(attempt)) return attempt;
    }
    const preferences = Array.isArray(value.effective_preferences) ? value.effective_preferences : [];
    const { kept, ranked } = inlineRanking(preferences, entryWorkKind(value), projectWords(value, projectPath));
    const tiers = indexTiers(preferences, ranked);
    const leanest = levels.at(-1);
    const steps = detailSteps(leanest);
    const bounded = [...levels, ...steps.map((_, index) => reducedDetails(leanest, steps.slice(0, index + 1)))];
    // Past this point a frame without a floor says so (NOT_HELD).
    let mark = candidate => candidate;
    const fitsAt = (level, selected, index) => fits(complete(mark(withPreferences(level, selected, preferences.length, index))));
    // Step 1 and 2 above: the preferences' floor, the recall and the
    // conversation, then more preferences while they fit (never fewer than held).
    const floor = withFloor ? preferenceFloor(value, kept, ranked, limit, tiers, measure) : null;
    const shared = floor && sharedFit({ preferences, kept, ranked, floor, held, levels, leanest, fitsAt, tiers,
      frameAt: frame => bestLevel(levels, levels.length, [], leanest, candidate => deliver(frame(candidate)), fits),
      delivers: frame => fits(deliver(frame)) });
    if (shared) return shared;
    if (withFloor && !floor && preferences.length) mark = candidate => copyPreferenceScope(candidate, { ...candidate, ...NOT_HELD });
    // The richest level where every hard rule fits, and what the search may
    // leave out there: the ranked rest. Where none fits, the hard rules
    // themselves at the leanest level. The index is never part of this: a hard
    // rule is delivered in full or not at all (D-69).
    const base = bounded.slice(levels.length - 1).find(level => fitsAt(level, new Set(kept), false));
    const [level, fixed, order] = base ? [base, kept, ranked] : [bounded.at(-1), [], kept.length ? kept : ranked];
    const richer = bounded.slice(0, bounded.indexOf(level) + 1);
    const selection = count => new Set([...fixed, ...order.slice(0, count)]);
    // The largest prefix of `order` that fits with the given index tier; at a
    // detail level that may be all of it.
    const largestPrefix = index => {
      let low = 0;
      let high = order.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (fitsAt(level, selection(middle), index)) low = middle;
        else high = middle - 1;
      }
      return low;
    };
    // Naming every other preference comes before spelling more of them out
    // (rec#137): the model then knows what exists and reads only what this
    // task may touch. A line each where that fits, the keys alone where it
    // does not, a count where even those do not — and never at the cost of a
    // hard rule's body (D-69):
    // - every hard rule fits (base): the index is chosen beside them and the
    //   best-ranked few this task's own scene asked for (rec#111), then the
    //   ranked rest fills what is left;
    // - they do not all fit: `order` is the hard rules themselves, so their
    //   prefix is settled without any index first, and an index tier is taken
    //   only in the room that prefix leaves.
    let indexed, low;
    if (base) {
      const reserved = Math.min(RESERVED_RANKED, order.length);
      indexed = indexDetail(detail => fitsAt(level, selection(reserved), detail), tiers);
      low = largestPrefix(indexed);
    } else {
      low = largestPrefix(false);
      indexed = indexDetail(detail => fitsAt(level, selection(low), detail), tiers);
    }
    const frame = candidate => mark(low === order.length ? candidate
      : withPreferences(candidate, selection(low), preferences.length, indexed));
    const attempt = bestLevel(richer, levels.length, steps, leanest, candidate => deliver(frame(candidate)), fits);
    if (attempt) return attempt;
    // Not even the leanest entry fits beside the hard rules (a long role,
    // which is never cut): the blocked frame keeps the token, closing fields
    // and identity, and lists the largest prefix of the same ranking that
    // still fits beside them, rather than none (rec#128).
    if (!preferences.length) return deliver(blockedPreferenceDelivery(value, INLINE_BUDGET));
    const ordered = [...kept, ...ranked];
    const blocked = (count, index) => withDeliveredHabits(blockedPreferenceDelivery(value, INLINE_BUDGET,
      selectedPreferences(value, new Set(ordered.slice(0, count)), preferences.length, index)));
    let listed = 0;
    let most = ordered.length;
    while (listed < most) {
      const middle = Math.ceil((listed + most) / 2);
      if (fits(deliver(blocked(middle, false)))) listed = middle;
      else most = middle - 1;
    }
    // The same listed set, plus the richest index of everything else that fits
    // beside it: a blocked frame is where knowing what exists matters most, and
    // it still never costs one of the rules it lists.
    let named = null;
    indexDetail(detail => {
      const attempt = deliver(blocked(listed, detail));
      if (!fits(attempt)) return false;
      named = attempt;
      return true;
    }, tiers);
    return named ?? deliver(blocked(listed, false));
  };
}

// The first of `richer` (the context levels, then the detail levels after the
// `contextCount` of them) whose frame fits, or null. A detail level reduces
// every detail before its own; each of them comes back on its own while it
// fits, the last reduced first.
function bestLevel(richer, contextCount, steps, leanest, frameAt, fits) {
  for (const [index, candidate] of richer.entries()) {
    const attempt = frameAt(candidate);
    if (!fits(attempt)) continue;
    let reduced = steps.slice(0, Math.max(0, index - contextCount + 1));
    let best = attempt;
    for (const step of [...reduced].reverse()) {
      const without = reduced.filter(item => item !== step);
      const restored = frameAt(reducedDetails(leanest, without));
      if (fits(restored)) [reduced, best] = [without, restored];
    }
    return best;
  }
  return null;
}

// The share of a host's inline limit the preferences of an entry that does
// not fit whole are always given (design T3), measured as the JSON of what
// they deliver: the listed bodies and the omission with its index. It is a
// floor, not a cap: the recall and the conversation give way down to it, and
// whatever room they leave goes to more preferences. A preference named only
// by its key in the index cannot be judged to apply, so a body the limit can
// hold is never left out to keep room empty. Half the limit holds what real
// bounded entries listed (70 preferences of about 130 characters: hard rules,
// five to eight bodies and a line for each of the rest) beside an entry's own
// fields (about 3.5k characters, token-budget.test.js noMatchEntryChars).
const PREFERENCE_SHARE = 0.5;

// The preferences' floor: every hard rule, the largest ranked prefix and the
// richest index that fit in their share, chosen the way the search below
// chooses (the best-ranked few before the index, the index before any more of
// them), as { count, indexed }. It depends on the preferences alone, so every
// turn with the same set has the same floor. Where not even the keys of the
// rest fit beside the hard rules, the rest are counted (indexed false), as the
// search below does: about 70 real preferences with 30-to-45-character keys
// and 8 hard rules come to some 5.9k characters with their keys, past a
// 4.5k share, and without this no frame of such a session held its set
// (`a real-scale working set`, entry-inline-budget.test.js). Null only where
// the hard rules alone exceed the share: the search then bounds them beside
// the rest, and the frame says so (NOT_HELD).
function preferenceFloor(value, kept, ranked, limit, tiers, measure) {
  const total = value.effective_preferences?.length ?? 0;
  const share = Math.floor(limit * PREFERENCE_SHARE);
  const selection = count => new Set([...kept, ...ranked.slice(0, count)]);
  const fitsShare = (count, index) => measure(JSON.stringify(selectedPreferences(value, selection(count), total, index))) <= share;
  if (!total || !fitsShare(0, false)) return null;
  const indexed = indexDetail(detail => fitsShare(Math.min(RESERVED_RANKED, ranked.length), detail), tiers)
    || indexDetail(detail => fitsShare(0, detail), tiers);
  return { count: largestCount(0, ranked.length, count => fitsShare(count, indexed)), indexed };
}

// What a bounded frame says where the preferences have no floor (the hard
// rules alone fill their share): no frame holds the set its base listed, so
// each is chosen afresh, as main does, and may be complete again. A short,
// visible reason, so that this is never switched off unnoticed.
const NOT_HELD = Object.freeze({ preferences_not_held: 'hard rules fill half the inline limit' });

// The largest count in [low, high] that `accepts`, given that `low` does.
function largestCount(low, high, accepts) {
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (accepts(middle)) low = middle;
    else high = middle - 1;
  }
  return low;
}

// The entry bounded around the preferences' floor, or null where the floor
// does not fit beside the leanest context (the search then decides).
// - The session's first frame of a generation or of a scope (no `held`): the
//   ranked preferences after the floor are added while the complete frame
//   still fits beside the leanest context, and the recall and the
//   conversation then take the richest level that fits beside them.
// - A later frame (`held`, what its base frame spelled out) never lists fewer
//   (heldFit).
function sharedFit({ preferences, kept, ranked, floor, held, levels, leanest, fitsAt, tiers, frameAt, delivers }) {
  const listing = (selected, index) => candidate => selected.size === preferences.length ? candidate
    : withPreferences(candidate, selected, preferences.length, index);
  const selection = (order, count) => new Set([...kept, ...order.slice(0, count)]);
  // As in the floor, the best-ranked few come first (rec#111), then a line
  // for each left-out item before more bodies (rec#137): the lines are what
  // tell the model which ones to read. Where the whole frame has room for a
  // richer tier than the floor's share did (lines over keys, keys over a
  // count), it takes it, as the search below would. A later frame takes only
  // the lines: it has room because the bodies the model holds are not
  // repeated, and keys alone, sent once for that room, say nothing the model
  // can judge by (`keys` false).
  const richerIndex = (level, order, { keys = true } = {}) => {
    const reserved = selection(order, Math.max(floor.count, Math.min(RESERVED_RANKED, order.length)));
    return INDEX_TIERS.slice(0, INDEX_TIERS.indexOf(floor.indexed)).filter(tier => tiers.includes(tier) && (keys || tier !== 'keys'))
      .find(tier => fitsAt(level, reserved, tier)) ?? floor.indexed;
  };
  if (held) return heldFit({ preferences, ranked, floor, held, levels, leanest, fitsAt, frameAt, delivers, listing, selection, richerIndex });
  // As main does, the bodies are counted beside the leanest context first,
  // and the recall and the conversation take the richest level that fits
  // beside them: a first frame never spells out fewer than main's would.
  if (!fitsAt(leanest, selection(ranked, floor.count), floor.indexed)) return null;
  const indexed = richerIndex(leanest, ranked);
  const count = largestCount(floor.count, ranked.length, middle => fitsAt(leanest, selection(ranked, middle), indexed));
  return frameAt(listing(selection(ranked, count), indexed));
}

// A later frame of the same generation and scope. What its base spelled out
// stays spelled out: dropping one would make the frame complete again (a
// bounded frame never names a removal, preference-snapshot.js), while adding
// one only sends its body once in the delta. So the base's set (the first
// frame's floor among it) takes the richest level where the frame this turn actually delivers fits,
// and then the rest are added in rank order while it still fits, up to what
// one complete frame holds beside the leanest context (the cap), plus the
// preferences the person added in this generation and scope, within a quota
// (ADDED_QUOTA_MIN): a turn with a lighter
// recall spells out what a richer first frame only named, never more than the
// lightest turn would list whole, so the bodies of every preference are not
// sent one turn after another. While an earlier frame is still on its way
// (preference-session.js) it adds none.
// Only where the base's set does not fit even so (a body grew, or this frame
// must be complete) does it give way, as a complete frame beside the leanest
// context: a preference changed since the base first, so the model is not left
// with its old body and a line, then the base's set and the added ones by
// rank, then the rest; hard rules are always listed.
// The frame it returns carries `added`: what the session keeps with it for the
// next frame (preference-session.js), the added ones it still owes and the new
// ones it left to rank (indexes into the entry's preferences), and the quota
// spent so far.
function heldFit({ preferences, ranked, floor, held, levels, leanest, fitsAt, frameAt, delivers, listing, selection, richerIndex }) {
  const status = new Map(ranked.map(index => [index, heldStatus(preferences[index], held)]));
  const of = (...kinds) => ranked.filter(index => kinds.includes(status.get(index)));
  // The most a generation spells out: what a first frame would list beside
  // the leanest context, by rank, its index tier included (as main listed on
  // its lightest turn), counting only the preferences there before. A first
  // frame that a rich recall kept below it catches up; nothing goes past it
  // but what the base already holds and the added ones within the quota.
  // Hard rules are never counted.
  const lightest = richerIndex(leanest, ranked, { keys: false });
  const capOf = order => largestCount(0, order.length, count => fitsAt(leanest, selection(order, count), lightest));
  const cap = capOf(ranked.filter(index => status.get(index) !== 'new'));
  // The first frame spelled out the floor, so the base holds it. One that
  // ranks into it later comes in by rank like the rest, and one the person
  // added only through the quota below, which the floor's place uses first:
  // an import that outranks everything would otherwise take the floor batch
  // by batch.
  const baseItems = of('listed', 'changed');
  const base = baseItems.length;
  // A preference the person added (heldStatus 'new') is not held to the cap:
  // they just set it, and main would give it a body on the next turn. That is
  // for the few they just said, not an import: the generation spells out at
  // most the quota that way, the floor's own place included (the cap, or
  // what the base spelled out of its own where that is more), best-ranked
  // first, each only where fewer than the cap of the older ones rank above it
  // and its body fits beside the leanest context at all (one that never fits would keep the recall at its leanest
  // turn after turn). The rest rank like any other and are only named past
  // the cap, as on main; none of them is owed. Whatever is left of the quota,
  // the few a person said just now (new, never owed or in view before) always
  // get room for ADDED_QUOTA_MIN of them: a habit said once a quota is spent
  // must not wait for a complete frame, and the rest of a larger batch is an
  // import, which the quota still bounds.
  const quota = Math.min(Math.max(cap, base - held.spent, ADDED_QUOTA_MIN), ADDED_QUOTA_MAX);
  const owes = index => heldOwes(preferences[index], held);
  let above = 0;
  const candidates = [];
  ranked.forEach((index, rank) => {
    if (status.get(index) !== 'new') above++;
    else if (rank < floor.count || above < cap) candidates.push(index);
  });
  // The few just said and the owed ones (said before, not spelled out yet)
  // get room for at least ADDED_QUOTA_MIN of them whatever is left of the
  // quota, the ones just said first.
  const fresh = of('new').filter(index => !owes(index)).length;
  const owing = of('new').filter(owes).length;
  let room = Math.max(quota - held.spent, Math.min(fresh + owing, ADDED_QUOTA_MIN));
  const added = [];
  const fitsAlone = index => delivers(listing(selection([...baseItems, index], base + 1), lightest)(leanest));
  const take = index => { if (room > 0 && fitsAlone(index)) { added.push(index); room--; } };
  candidates.filter(index => !owes(index)).forEach(take);
  candidates.filter(owes).forEach(take);
  const growing = [...new Set([...baseItems, ...added, ...ranked])];
  const indexed = richerIndex(leanest, growing, { keys: false });
  const most = Math.max(base, cap) + added.length;
  // What the session keeps: the added ones not spelled out are owed, and so
  // are the owed ones that got no room this time (never taken as in view, so
  // a habit said once is not left to a complete frame); the new ones left to
  // rank are in view from now on (heldPreferences `known`), and the spent
  // quota never passes what the record keeps.
  const tally = selected => ({ owed: [...added.filter(index => !selected.has(index)),
    ...of('new').filter(index => owes(index) && !added.includes(index))].slice(0, ADDED_QUOTA_MAX),
    declined: of('new').filter(index => !added.includes(index) && !owes(index)),
    spent: Math.min(held.spent + added.filter(index => selected.has(index)).length, ADDED_QUOTA_MAX) });
  const chosen = selected => attempt => attempt && { ...attempt, added: tally(selected) };
  // The recall gives way to the added ones: the richest level where the base's
  // set and every added body fit; where none does, the leanest level, with the
  // added ones by rank as far as they fit there. While an earlier frame is on
  // its way, none is added; they stay owed and come on a later turn.
  const wanted = held.grow ? base + added.length : base;
  // Never a richer index than the floor's for want of room: the floor's
  // tier, or the keys where the floor names each by a line.
  for (const index of new Set([indexed, floor.indexed, ...(floor.indexed === 'full' ? ['keys'] : [])])) {
    const at = count => listing(selection(growing, count), index);
    const level = levels.find(candidate => delivers(at(wanted)(candidate)))
      ?? (delivers(at(base)(leanest)) ? leanest : null);
    if (!level) continue;
    const count = held.grow ? largestCount(base, most, middle => delivers(at(middle)(level))) : base;
    return chosen(selection(growing, count))(frameAt(at(count)));
  }
  const giving = [...new Set([...of('changed'), ...baseItems, ...added, ...ranked])];
  if (!fitsAt(leanest, selection(giving, 0), indexed)) return null;
  const count = largestCount(0, giving.length, middle => fitsAt(leanest, selection(giving, middle), indexed));
  return chosen(selection(giving, count))(frameAt(listing(selection(giving, count), indexed)));
}

// The most bodies a generation spells out on top of its cap for preferences
// the person added (heldFit): the cap again, at least this few, so a person
// who just set two or three is always followed, and never more than the most
// the session record keeps owed (preference-session.js).
const ADDED_QUOTA_MIN = 3;
export const ADDED_QUOTA_MAX = 64;

// The index tiers, richest first; false (a count) is the last.
const INDEX_TIERS = ['full', 'keys', false];

// The richest index tier the caller accepts, or false when none is taken.
function indexDetail(accepts, tiers = INDEX_TIERS) {
  return tiers.find(detail => detail && accepts(detail)) ?? false;
}

// The index tiers an entry may take. A key FULI made from a habit's text
// (task-remember.js: `remember-` and 24 hex) says nothing a reader can judge
// by, so where most of the keys the index could name are such keys, a
// keys-only index is not taken: the room goes to more bodies, and the rest
// are counted (rec#11 D-54 review). A line still says what each one is about.
function indexTiers(preferences, ranked) {
  const generated = ranked.filter(index => generatedPreferenceKey(preferences[index]?.preference_key)).length;
  return generated * 2 > ranked.length ? INDEX_TIERS.filter(tier => tier !== 'keys') : INDEX_TIERS;
}

// How many of the best-ranked preferences keep their full body before the
// index of the rest is considered (rec#111): the task's own scene asked for
// these, and reading them should not cost a second call.
const RESERVED_RANKED = 3;

// A more specific rule overrides a broader one, so it is the one the model is
// least able to infer: hard rules that must be trimmed keep these first (D-69).
const SCOPE_SPECIFICITY = Object.freeze({ agent: 0, project: 1, global: 2 });
const specificity = item => SCOPE_SPECIFICITY[item.preference_scope] ?? 3;

// Indexes into effective_preferences: those that always stay, most specific
// scope first, then the Provider's order, and the rest in rank order. An item
// whose instruction states a scope this session's project does not meet ranks
// after the rest (statedScopeMeetsProject, rec#111): it is the one least
// likely to belong here, and the index still names it with "· 仅适用于 X".
// Nothing in the ranking depends on the turn's prompt, so the same set selects
// the same items on the next turn and a delta follows.
function inlineRanking(preferences, workKind, words = []) {
  const kept = [], optional = [];
  preferences.forEach((item, index) => (preferenceAlwaysInline(item) ? kept : optional).push(index));
  kept.sort((a, b) => specificity(preferences[a]) - specificity(preferences[b]) || a - b);
  const rank = index => [statedScopeMeetsProject(preferences[index], words) ? 0 : 1,
    preferenceSceneReplaceable(preferences[index]) ? 1 : 0,
    preferenceNamesWorkKind(preferences[index], workKind) ? 0 : 1,
    preferences[index].confirmation_status === 'confirmed' ? 0 : 1, index];
  const ranked = optional.map(index => [rank(index), index])
    .sort(([a], [b]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3] || a[4] - b[4]).map(([, index]) => index);
  return { kept, ranked };
}

// A frame that leaves preferences or conflicts out is not the complete set a
// reader's result (read_task_preferences, behind a restore or refresh)
// declares, so those claims go. preferences_complete is not set false, which
// would make it a blocked frame.
function withoutCompleteClaims(value) {
  const { preferences_complete: _complete, same_task_recovery_available: _recovery, preference_delivery: delivery, ...rest } = value;
  return { ...rest, ...(delivery && delivery.status !== 'complete' ? { preference_delivery: delivery } : {}) };
}

function withoutPreferenceIds(value) {
  if (!Array.isArray(value.effective_preferences) || !value.effective_preferences.some(item => item.id)) return value;
  return copyPreferenceScope(value, { ...value,
    effective_preferences: value.effective_preferences.map(({ id: _id, item_kind: _kind, ...item }) => item) });
}

function withPreferences(level, selected, total, indexed) {
  return copyPreferenceScope(level, withDeliveredHabits({ ...withoutCompleteClaims(level),
    ...selectedPreferences(level, selected, total, indexed) }));
}

// The listed subset and what it leaves out: its count, its one-line index when
// that fits (preference-index.js, rec#137), and the read that expands it, named
// only where the reader can serve it (taskPreferenceRead, rec#128).
function selectedPreferences(value, selected, total, indexed = false) {
  const read = taskPreferenceRead(value);
  const index = indexed ? preferenceIndex(value.effective_preferences, selected, indexed) : [];
  return { effective_preferences: value.effective_preferences.filter((_, index) => selected.has(index)),
    preferences_omitted: { count: total - selected.size,
      ...(value.effective_preferences.some((item, index) => !selected.has(index) && preferenceAlwaysInline(item))
        ? { includes_always_inline: true } : {}),
      ...(index.length ? { index } : {}),
      ...(read ? { read } : {}) } };
}

// The entry, then each smaller context: the recall as a pointer, then the
// conversation window without its oldest message, one at a time. A window
// that drops a message says so as the Provider does: truncated, with the
// latest omitted sequence; read_agent_conversation reads it whole.
function contextLevels(value) {
  const levels = [value];
  let current = value;
  const recall = value.task_knowledge_recall;
  if (recall?.facts?.length || recall?.entities?.length || recall?.knowledge_index) {
    current = copyPreferenceScope(value, { ...value, task_knowledge_recall: recallPointer(recall) });
    levels.push(current);
  }
  const recovery = current.conversation?.recovery;
  const messages = Array.isArray(recovery?.messages) ? recovery.messages : [];
  for (let dropped = 1; dropped <= messages.length; dropped++) {
    levels.push(copyPreferenceScope(value, { ...current, conversation: { ...current.conversation, recovery: { ...recovery,
      messages: messages.slice(dropped), truncated: true,
      omitted_sequence: Math.max(recovery.omitted_sequence ?? 0, messages[dropped - 1].sequence) } } }));
  }
  return levels;
}

// The detail steps that have something to reduce in `leanest`, in order.
// Each touches one field, so any subset of them applies on its own.
function detailSteps(leanest) {
  return DETAIL_STEPS.filter(step => step(leanest));
}

function reducedDetails(leanest, steps) {
  return copyPreferenceScope(leanest, steps.reduce((value, step) => step(value) ?? value, leanest));
}

const withContinuity = (value, field, view) => ({ ...value, project_agent_context: { ...value.project_agent_context, [field]: view } });
const present = values => Object.fromEntries(Object.entries(values).filter(([, item]) => item !== undefined));

// Each step returns the entry with one detail reduced to what it counts and
// the call that reads it, or null when there is nothing to reduce. The role is
// never cut: recovery does not cut role instructions either
// (task-preference-reader.js), so an entry that needs it is the blocked frame.
const DETAIL_STEPS = [
  // The global layer first, as it is the less specific one.
  value => value.project_agent_context?.global_memory?.current ? withContinuity(value, 'global_memory',
    memoryPointer(value.project_agent_context.global_memory, memoryRead(value, null))) : null,
  value => value.project_agent_context?.memory?.current ? withContinuity(value, 'memory',
    memoryPointer(value.project_agent_context.memory, memoryRead(value, value.context?.personal_project_id ?? null))) : null,
  // The snapshot's files are written with the memory the layers' read returns.
  value => {
    const snapshot = value.project_agent_context?.directorySnapshot;
    return Array.isArray(snapshot?.files) ? withContinuity(value, 'directorySnapshot',
      { status: snapshot.status, path: snapshot.path, files_omitted: snapshot.files.length,
        read: memoryRead(value, value.context?.personal_project_id ?? null) }) : null;
  },
  value => {
    const team = value.project_agent_context?.team;
    return team?.roster?.length ? withContinuity(value, 'team', { roster_total: team.roster_total ?? team.roster.length,
      read: teamRead(value) }) : null;
  },
  value => {
    const managers = value.project_management_context?.managers;
    return managers?.length ? { ...value, project_management_context: { ...value.project_management_context,
      managers: managers.map(manager => present({ template_id: manager.template_id, agent_id: manager.agent_id, name: manager.name,
        title_mode: manager.title_mode, suggested_match: manager.suggested_match, guidance: manager.guidance,
        read: managerRead(manager) })) } } : null;
  },
  ({ active_conflicts: conflicts, ...value }) => {
    const read = taskPreferenceRead(value);
    return conflicts?.length ? { ...withoutCompleteClaims(value),
      active_conflicts_omitted: { count: conflicts.length, ...(read ? { read } : {}) } } : null;
  }
];

// A layer's preview without its notes: its scope, revision and rules stay,
// so a checkpoint still names the revision it read (task-context-view.js).
function memoryPointer(memory, read) {
  const { current: _current, notesTruncated: _cut, ...pointer } = memory;
  return { ...pointer, view: 'omitted', read };
}

// The recall without its items: what it matched, how many, and the search
// that reads them (task_knowledge_recall's own guidance says how to query).
// A title-only knowledge_index (rec#51 D-59) is per task like the recall, so
// it goes with the recall, before any preference.
function recallPointer(recall) {
  const { facts = [], entities = [], knowledge_index: index, sourceMarker: _marker, noMatchSourceMarker: _none,
    pending_fallback: _pending, confirmed_use: _confirmed, retrieval_budget: _budget, ...summary } = recall;
  return { ...summary, items_omitted: facts.length + entities.length + (index?.items.length ?? 0),
    read: { tool: 'search_current_project_knowledge' } };
}

// What a prose-stated scope is read against: the project this entry matched
// (its ID and name) and the folder the session works in. Stable for a session.
function projectWords(value, projectPath) {
  return [value.context?.personal_project_id, value.project_agent_context?.project_brief?.name,
    typeof projectPath === 'string' && projectPath.trim() ? basename(projectPath) : null];
}
