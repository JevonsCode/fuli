// Summarizes replayed turns into the PR3 buckets and the Markdown table.
// Bytes are real UTF-8 bytes of the injected additionalContext; no tokens.

export const BUCKETS = Object.freeze({
  first_or_reset_full: '(1) first or post-reset full',
  changed_full: '(2) full again: something changed, or the earlier frame was not confirmed',
  incremental: '(3) incremental: a preference delta/scene switch or seen messages left out'
});
export const UNIT_NOTE = 'UTF-8 bytes of the injected hook additionalContext, measured by synthetic replay. No token estimates.';

const sum = (turns, field) => turns.reduce((total, turn) => total + turn[field], 0);

export function summarize(name, { turns, checks, retrieval }) {
  const buckets = Object.fromEntries(Object.keys(BUCKETS).map(bucket => {
    const inBucket = turns.filter(turn => turn.bucket === bucket);
    return [bucket, { turns: inBucket.length, injected_bytes: sum(inBucket, 'injected_bytes'),
      no_cache_bytes: sum(inBucket, 'no_cache_bytes') }];
  }));
  const codex = turns.filter(turn => turn.client === 'codex' && turn.resent_items > 0);
  const delivered = turns.filter(turn => turn.correctness);
  return { scenario: name, turns: turns.length, buckets,
    injected_bytes: sum(turns, 'injected_bytes'), no_cache_bytes: sum(turns, 'no_cache_bytes'),
    codex_resend: { frames: codex.length, items: sum(codex, 'resent_items'), already_seen_items: sum(codex, 'resent_seen_items') },
    pointer_bytes: turns.map(turn => turn.pointer_bytes).filter(value => value !== null),
    retrieval_calls: { total: Object.values(retrieval).reduce((total, value) => total + value, 0), ...retrieval },
    correctness: { delivered_turns: delivered.length, correct_turns: delivered.filter(turn => turn.correctness.ok).length,
      withdrawn_present: delivered.flatMap(turn => turn.correctness.withdrawn_present) },
    checks, detail: turns };
}

export function markdownTable(results) {
  const cell = bucket => `${bucket.turns} / ${bucket.injected_bytes} (${bucket.no_cache_bytes})`;
  const rows = results.map(result => [result.scenario, result.turns, cell(result.buckets.first_or_reset_full),
    cell(result.buckets.changed_full), cell(result.buckets.incremental),
    `${result.injected_bytes} (${result.no_cache_bytes})`,
    `${result.codex_resend.frames} (${result.codex_resend.items} items, ${result.codex_resend.already_seen_items} seen)`,
    result.pointer_bytes.join(', ') || '–', result.retrieval_calls.total,
    `${result.correctness.correct_turns}/${result.correctness.delivered_turns}, withdrawn present ${result.correctness.withdrawn_present.length}`,
    `${result.checks.filter(check => check.pass).length}/${result.checks.length}`]);
  return [
    `Bytes only: ${UNIT_NOTE} Cells are turns / injected bytes (no-cache bytes for the same entries).`,
    '',
    '| scenario | turns | (1) first/reset full | (2) full again | (3) incremental | total injected (no cache) | Codex resend frames | pointer B | retrieval calls | model view correct | checks |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map(row => `| ${row.join(' | ')} |`)
  ].join('\n');
}
