// One page of numbers, and the per-case lines that explain them.

const pct = (part, whole) => (whole ? `${((part / whole) * 100).toFixed(1)}%` : '-');
const line = (label, value) => `  ${label.padEnd(34)}${value}`;

export function formatReport({ preferences, entry, search, environment }) {
  const out = [];
  out.push('FULI recall-rate benchmark');
  out.push(`  fixture world: ${environment.items} items, ${environment.projects} projects, one personal space`);
  out.push(`  ranked by:     ${environment.interpreter}`);
  out.push('');

  const a = preferences.totals;
  out.push('A. Preferences the entry delivers on its own');
  out.push(line('tasks', a.cases));
  out.push(line('should deliver / delivered', `${a.should_deliver} / ${a.delivered}  (${pct(a.delivered, a.should_deliver)})`));
  out.push(line('must not deliver / delivered', `${a.must_not_deliver} / ${a.wrongly_delivered}  (${pct(a.wrongly_delivered, a.must_not_deliver)})`));
  out.push(line('  of those, scope-qualified', `${a.scope_qualified_must_not_deliver} / ${a.scope_qualified_wrongly_delivered}  (${pct(a.scope_qualified_wrongly_delivered, a.scope_qualified_must_not_deliver)})`));
  out.push(line('mean preferences per task', a.mean_delivered_per_task));
  for (const entryCase of preferences.cases.filter(item => item.missing.length || item.wrong.length)) {
    out.push(`    ${entryCase.id}: missing [${entryCase.missing}] wrong [${entryCase.wrong}]`
      + (entryCase.knownGap ? ` (known gap: ${entryCase.knownGap})` : ''));
  }
  out.push('');

  const b = entry.totals;
  out.push('B. Knowledge the entry recalls on its own');
  out.push(line('tasks', b.cases));
  out.push(line('should recall / recalled', `${b.should_recall} / ${b.recalled}  (${pct(b.recalled, b.should_recall)})`));
  out.push(line('must not recall / recalled', `${b.must_not_recall} / ${b.wrongly_recalled}  (${pct(b.wrongly_recalled, b.must_not_recall)})`));
  out.push(line('delivered items / off target', `${b.delivered_items} / ${b.off_target_items}`));
  out.push(line('precision of delivered items', b.precision ?? '-'));
  out.push(line('mean bytes / approx tokens', `${b.mean_bytes} B / ~${b.mean_approx_tokens} tok`));
  out.push(line('mean recall wall time', `${b.mean_ms} ms`));
  for (const item of entry.cases) {
    out.push(`    ${item.id.padEnd(22)} ${String(item.status).padEnd(16)} q=${item.queries}`
      + ` got [${item.delivered.join(' ')}]${item.missing.length ? ` MISSING [${item.missing.join(' ')}]` : ''}`
      + `${item.wrong.length ? ` WRONG [${item.wrong.join(' ')}]` : ''}`);
  }
  out.push('');

  const c = search.totals;
  out.push('C. Searches the Agent makes for itself');
  out.push(line('calls', c.calls));
  out.push(line('gold found anywhere in results', `${c.found_in_ranking} / ${c.should_find}  (${pct(c.found_in_ranking, c.should_find)})`));
  out.push(line(`calls with gold in top ${5}`, `${c.in_top_k} / ${c.calls}  (${pct(c.in_top_k, c.calls)})`));
  out.push(line('MRR over calls', c.mrr));
  out.push(line('forbidden items in top 5', c.forbidden_in_top_k));
  out.push(line('gold lost to the page budget', c.lost_to_budget));
  out.push(line('calls truncated by the budget', `${c.truncated_calls} / ${c.calls}`));
  out.push(line('mean delivered / ranked items', `${c.mean_delivered_items} / ${c.mean_total_items}`));
  out.push(line('mean bytes / approx tokens', `${c.mean_bytes} B / ~${c.mean_approx_tokens} tok`));
  out.push(line('mean rank / page time', `${c.mean_rank_ms} ms / ${c.mean_page_ms} ms`));
  out.push('  by query language:');
  for (const [language, totals] of Object.entries(search.by_language)) {
    if (!totals) continue;
    out.push(`    ${language.padEnd(6)} gold ${totals.found_in_ranking}/${totals.should_find}`
      + `  top5 ${totals.in_top_k}/${totals.calls}  MRR ${totals.mrr}`
      + `  noise@5 ${totals.forbidden_in_top_k}  lost ${totals.lost_to_budget}`);
  }
  for (const item of search.cases) {
    out.push(`    ${item.id.padEnd(22)} rank=${item.best_rank ?? '-'} delivered=${item.delivered_items}/${item.total_items}`
      + ` ${item.bytes}B${item.forbidden_in_top_k.length ? ` NOISE@5 [${item.forbidden_in_top_k.join(' ')}]` : ''}`
      + `${item.lost_to_budget.length ? ` LOST [${item.lost_to_budget.join(' ')}]` : ''}`);
  }
  return out.join('\n');
}
