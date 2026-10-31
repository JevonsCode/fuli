const fs = require('node:fs');
const path = require('node:path');

// Synthetic scenarios: query, answer, wrong near-duplicate, related context.
const cases = [
  ['backup restore destination', 'Restore backups into an isolated staging directory before replacing the live store.', 'Restore backups directly over the live store without checking.', 'Backups are created before a store migration.'],
  ['release signing key', 'The release signing key is held by the release operator.', 'The release signing key is committed to the repository.', 'Release artifacts have checksums for verification.'],
  ['mobile pairing expiry', 'The mobile pairing code expires after five minutes.', 'The mobile pairing code never expires.', 'A mobile pairing session uses a six digit code.'],
  ['router domestic traffic', 'Domestic traffic uses the direct router route.', 'Domestic traffic always uses the overseas proxy.', 'The router also has a separate AI traffic rule.'],
  ['invoice approval threshold', 'Invoices above 5000 require manager approval.', 'Invoices above 5000 are automatically approved.', 'Invoices include the supplier and purchase order.'],
  ['incident escalation owner', 'The on call engineer escalates a severe incident to the incident lead.', 'The on call engineer waits until the next week to escalate a severe incident.', 'The incident lead maintains the incident timeline.'],
  ['customer export format', 'Customer exports are delivered as UTF-8 CSV files.', 'Customer exports are delivered only as screenshots.', 'The customer export contains an account identifier.'],
  ['garden watering schedule', 'Water the greenhouse plants every Tuesday morning.', 'Water the greenhouse plants only in December.', 'The greenhouse has a rainwater collection tank.'],
  ['database migration rollback', 'Keep the pre-migration backup until rollback has been verified.', 'Delete the pre-migration backup before running the migration.', 'The migration records its schema version.'],
  ['meeting notes location', 'Save the team meeting notes in the shared project notebook.', 'Save the team meeting notes only on a personal desktop.', 'The meeting agenda includes decisions and action items.'],
  ['support response language', 'Reply to this customer in French.', 'Reply to this customer only in Japanese.', 'The customer reported a delayed shipment.'],
  ['api retry policy', 'Retry transient API failures with exponential backoff.', 'Retry every API failure immediately without a limit.', 'API requests include a request identifier.'],
  ['library opening hours', 'The library opens at nine on weekdays.', 'The library opens at midnight on weekdays.', 'The library closes on public holidays.'],
  ['project archive retention', 'Keep archived project records for seven years.', 'Delete archived project records after one day.', 'Project records include the final owner.'],
  ['conference room capacity', 'The north conference room seats twelve people.', 'The north conference room seats two hundred people.', 'The north conference room has a projector.'],
  ['password reset channel', 'Send password reset links through the verified email address.', 'Publish password reset links in the public forum.', 'Password reset links expire after use.'],
  ['deployment health check', 'Check the health endpoint after deploying the service.', 'Skip all checks after deploying the service.', 'The deployment records the revision identifier.'],
  ['design review participants', 'Invite the designer and accessibility reviewer to the design review.', 'Exclude the accessibility reviewer from the design review.', 'The design review considers keyboard navigation.'],
  ['warehouse reorder point', 'Reorder packing boxes when stock falls below 200.', 'Reorder packing boxes only after stock exceeds 2000.', 'Packing boxes are stored in aisle four.'],
  ['travel reimbursement receipt', 'Attach the original receipt to each travel reimbursement.', 'Travel reimbursement never needs a receipt.', 'Travel reimbursement uses the expense form.'],
  ['data retention logs', 'Delete routine application logs after thirty days.', 'Keep routine application logs forever.', 'Application logs exclude credentials.'],
  ['train ticket collection', 'Collect the train ticket from the station machine.', 'Collect the train ticket from the airport baggage belt.', 'The station machine accepts the booking code.'],
  ['code review ownership', 'The module owner reviews changes to the payment adapter.', 'The module owner is barred from reviewing the payment adapter.', 'The payment adapter has contract tests.'],
  ['report publication date', 'Publish the quarterly report on the first Monday of April.', 'Publish the quarterly report on the last Friday of December.', 'The quarterly report includes a revenue chart.'],
  ['office visitor access', 'Visitors sign in at reception before entering the office.', 'Visitors may enter the office without signing in.', 'Reception can issue a temporary visitor badge.'],
  ['sensor calibration interval', 'Calibrate the temperature sensor every six months.', 'Calibrate the temperature sensor once every fifty years.', 'The temperature sensor is mounted near the intake.'],
  ['contract renewal notice', 'Send the renewal notice sixty days before contract expiry.', 'Send the renewal notice sixty days after contract expiry.', 'The contract names a renewal contact.'],
  ['photo backup copies', 'Keep two independent copies of the photo archive.', 'Keep the photo archive on one drive only.', 'The photo archive is organized by year.'],
  ['queue worker concurrency', 'Run at most four queue workers for this job.', 'Run at least four hundred queue workers for this job.', 'Queue workers record failed attempts.'],
  ['billing currency preference', 'Show the invoice total in euros for this account.', 'Show the invoice total only in yen for this account.', 'The invoice also shows a tax line.'],
];

const items = [];
const queries = [];
cases.forEach(([query, answer, wrong, context], index) => {
  const prefix = `s${String(index + 1).padStart(2, '0')}`;
  const records = [
    ['a', answer, 'confirmed', false],
    ['b', answer, index % 2 ? 'agent_confirmed' : 'pending', index % 6 === 0],
    ['c', wrong, index % 3 ? 'confirmed' : 'agent_confirmed', index % 4 === 0],
    ['d', context, index % 2 ? 'pending' : 'agent_confirmed', index % 5 === 0],
  ];
  for (const [slot, statement, status, attention] of records) {
    const seed = index * 4 + slot.charCodeAt(0);
    const basis = {existence_reason: 'Synthetic statement for an offline benchmark.', quadrant_reason: 'Explicit scenario evidence.', proposed_by: {kind: 'agent'}};
    if (status !== 'pending') {
      basis.confirmed_by = {kind: status === 'confirmed' ? 'user' : 'agent'};
      basis.confirmed_at = '2026-01-02T00:00:00Z';
      if (status === 'agent_confirmed') basis.agent_policy_version = 'agent-usage-v1';
    }
    items.push({
      id: `${prefix}${slot}`, name: query, type: 'Knowledge', summary: statement,
      confirmation_status: status, confirmation_basis_json: basis,
      confidence_score: [0.35, 0.6, 0.85, 1][seed % 4], utility_score: [0, 0.3, 0.7, 1][(seed + index) % 4],
      qualified_use_count: [0, 2, 9, 30, 60][seed % 5], distinct_task_count: [0, 1, 3, 7][seed % 4],
      negative_evidence_count: [0, 0, 1, 3][(seed + index) % 4], requires_attention: attention,
      last_used_at: ['2026-10-01T00:00:00Z', '2026-04-01T00:00:00Z', '2024-01-01T00:00:00Z', null][seed % 4],
      evidence_ids: Array.from({length: seed % 6}, (_, n) => `${prefix}-source-${n}`),
      created_at: `2026-01-${String(1 + index % 28).padStart(2, '0')}T00:00:00Z`,
    });
  }
  // Exact answers have equal semantic relevance regardless of trust; the wrong
  // answer is irrelevant, and the related context has partial relevance.
  queries.push({id: prefix, query, judgments: {[`${prefix}a`]: 3, [`${prefix}b`]: 3, [`${prefix}c`]: 0, [`${prefix}d`]: 1}});
});
fs.writeFileSync(path.join(__dirname, 'recall_weight_benchmark.json'), JSON.stringify({items, queries}, null, 2) + '\n');
