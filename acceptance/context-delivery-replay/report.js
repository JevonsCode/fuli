// Summarizes replayed turns into the PR3 buckets and one Markdown table per
// variant. Bytes are real UTF-8 bytes of the hook additionalContext; no tokens.

export const BUCKETS = Object.freeze({
  first_or_reset_full: '(1) first or post-reset full',
  changed_full: '(2) full again: something changed, or the earlier frame was not confirmed',
  incremental: '(3) incremental: a preference delta/scene switch or seen messages left out'
});
export const UNIT_NOTE = 'UTF-8 bytes of the hook additionalContext, measured by synthetic replay. No token estimates.';
export const SCOPE_NOTES = Object.freeze([
  'produced = the additionalContext the hook returned; host-visible = what the host recorded for the model (0 when the output was lost, the preview when it was spilled). No other context cost is inferred.',
  'no cache = the same entry and the same Provider snapshot through the same hook without a session cache: a serialization comparison. Retrieval is counted on the cached path only; it was not executed again for the baseline.',
  'skeleton = the same entry without a cache, with no preference and no message: a separate diagnostic of what every turn costs. It is not part of any cache saving.',
  'tiny = the PR3 fixture; scaled = fixed-seed synthetic preferences of 120–400 B and messages of 120–1500 B; many = the same generator with 73 preferences, so the host inline limit decides what the model sees (rec#111, rec#137). All use the same prompts and the Provider recovery window: back to the third user message, packed into the default 4000-byte context_budget (test-support/synthetic-context-session.js PROVIDER_RECOVERY_WINDOW).',
  'est. tokens = src/text/token-estimate.js approxTokens of the same text: a reading-cost hint, not a tokenizer count.',
  'preferences inline = how the host inline limit (Claude Code 9000 chars) resolved: turns delivered as a blocked frame, preference bodies listed, items named in the short index, and items left out.',
  'The real claudeLifecycleOutput / codexLifecycleOutput functions run with synthetic transcripts and an in-memory Provider; no real client runs.',
  'The reset hooks get no currentTask, so SessionStart resume covers the next prompt after the reset, not the restored frame an active task receives at once. Explicit resume uses the real MCP result path and native tool records: only complete visible results suppress a later hook resend. Its tool-result bytes are outside these hook-only totals.'
]);

const sum = (turns, field) => turns.reduce((total, turn) => total + turn[field], 0);
const BYTE_FIELDS = ['produced_bytes', 'host_visible_bytes', 'no_cache_bytes', 'skeleton_bytes',
  'produced_tokens', 'no_cache_tokens'];
const totals = turns => Object.fromEntries(BYTE_FIELDS.map(field => [field, sum(turns, field)]));
// What the host's inline limit did to the preferences of these turns.
const inline = turns => ({ blocked_turns: turns.filter(turn => turn.blocked).length,
  listed_items: sum(turns, 'preferences_sent'), indexed_items: sum(turns, 'preferences_indexed'),
  omitted_items: sum(turns, 'preferences_omitted') });

export function summarize(name, { turns, checks, retrieval }) {
  const buckets = Object.fromEntries(Object.keys(BUCKETS).map(bucket => {
    const inBucket = turns.filter(turn => turn.bucket === bucket);
    return [bucket, { turns: inBucket.length, ...totals(inBucket) }];
  }));
  const codex = turns.filter(turn => turn.client === 'codex' && turn.resent_items > 0);
  const delivered = turns.filter(turn => turn.correctness);
  return { scenario: name, turns: turns.length, buckets, ...totals(turns), inline: inline(turns),
    rereads_required: sum(turns, 'rereads_required'),
    codex_resend: { frames: codex.length, items: sum(codex, 'resent_items'), already_seen_items: sum(codex, 'resent_seen_items') },
    pointer_bytes: turns.map(turn => turn.pointer_bytes).filter(value => value !== null),
    retrieval_calls: { total: Object.values(retrieval).reduce((total, value) => total + value, 0), ...retrieval },
    correctness: { delivered_turns: delivered.length, correct_turns: delivered.filter(turn => turn.correctness.ok).length,
      withdrawn_present: delivered.flatMap(turn => turn.correctness.withdrawn_present) },
    checks, detail: turns };
}

function scenarioTable(results) {
  const cell = bucket => `${bucket.turns} / ${bucket.produced_bytes} (${bucket.no_cache_bytes})`;
  const all = { scenario: '**all**', turns: sum(results, 'turns'), rereads_required: sum(results, 'rereads_required'), ...Object.fromEntries(BYTE_FIELDS.map(field => [field, sum(results, field)])),
    buckets: Object.fromEntries(Object.keys(BUCKETS).map(bucket => [bucket, { turns: sum(results.map(result => result.buckets[bucket]), 'turns'),
      ...Object.fromEntries(BYTE_FIELDS.map(field => [field, sum(results.map(result => result.buckets[bucket]), field)])) }])),
    codex_resend: Object.fromEntries(['frames', 'items', 'already_seen_items'].map(field => [field, sum(results.map(result => result.codex_resend), field)])),
    inline: Object.fromEntries(['blocked_turns', 'listed_items', 'indexed_items', 'omitted_items']
      .map(field => [field, sum(results.map(result => result.inline), field)])),
    pointer_bytes: results.flatMap(result => result.pointer_bytes),
    retrieval_calls: { total: sum(results.map(result => result.retrieval_calls), 'total') },
    correctness: { correct_turns: sum(results.map(result => result.correctness), 'correct_turns'),
      delivered_turns: sum(results.map(result => result.correctness), 'delivered_turns'),
      withdrawn_present: results.flatMap(result => result.correctness.withdrawn_present) },
    checks: results.flatMap(result => result.checks) };
  const rows = [...results, all].map(result => [result.scenario, result.turns, cell(result.buckets.first_or_reset_full),
    cell(result.buckets.changed_full), cell(result.buckets.incremental),
    result.produced_bytes, result.host_visible_bytes, result.no_cache_bytes, result.no_cache_bytes - result.produced_bytes,
    result.skeleton_bytes, `${result.produced_tokens} (${result.no_cache_tokens})`,
    `${result.inline.blocked_turns} blocked, ${result.inline.listed_items} listed, ${result.inline.indexed_items} indexed, ${result.inline.omitted_items} omitted`,
    `${result.codex_resend.frames} (${result.codex_resend.items} items, ${result.codex_resend.already_seen_items} seen)`,
    result.pointer_bytes.join(', ') || '–', result.retrieval_calls.total,
    `${result.correctness.correct_turns}/${result.correctness.delivered_turns}, withdrawn present ${result.correctness.withdrawn_present.length}`, result.rereads_required,
    `${result.checks.filter(check => check.pass).length}/${result.checks.length}`]);
  return [
    '| scenario | turns | (1) first/reset full | (2) full again | (3) incremental | produced | host-visible | no cache | no cache − produced | skeleton (diagnostic) | est. tokens (no cache) | preferences inline | Codex resend frames | pointer B | retrieval calls (cached path) | model view correct | rereads required | checks |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map(row => `| ${row.join(' | ')} |`)
  ].join('\n');
}

export function markdownTable(variants) {
  return [
    `Bytes only: ${UNIT_NOTE} Bucket cells are turns / produced bytes (no-cache bytes for the same entries).`,
    ...SCOPE_NOTES.map(note => `- ${note}`),
    ...variants.flatMap(({ variant, scenarios }) => ['', `**${variant}**`, '', scenarioTable(scenarios)])
  ].join('\n');
}
