import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  CLIENT_METERING_CONTRACT,
  attemptOutcome,
  claudeMetering,
  codexMetering,
  meteringLedger,
  parseJsonLines,
  recordAttempts,
  roundMoney,
  runMeteredAttempts
} from '../acceptance/alignment/client-metering.js';
import {
  attemptMeteringMarkdown,
  meteringTotalsMarkdown
} from '../acceptance/alignment/metering-report.js';

const stream = (...events) => events.map((event) => JSON.stringify(event)).join('\n');
const NOT_REPORTED = '未上报 / not reported';

// A complete Codex `turn.completed` modelled on the Usage struct of the frozen
// contract (openai/codex@067249a2 exec_events.rs L61-72), with the values of
// Codex's own parses_cache_write_token_usage test.
const CODEX_TURN_COMPLETED = Object.freeze({
  type: 'turn.completed',
  usage: {
    input_tokens: 100,
    cached_input_tokens: 40,
    cache_write_input_tokens: 60,
    output_tokens: 10,
    reasoning_output_tokens: 5
  }
});
const claudeResult = (fields = {}) => ({
  type: 'result',
  subtype: 'success',
  total_cost_usd: 0.25,
  usage: { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 2 },
  ...fields
});

function ledgerOf(callId, ...outcomes) {
  const ledger = meteringLedger();
  recordAttempts(ledger, callId, outcomes);
  return ledger;
}

test('the metering modules parse fakes and can never start a client', () => {
  for (const name of ['client-metering.js', 'metering-report.js']) {
    const source = readFileSync(new URL(`../acceptance/alignment/${name}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /child_process|\.\/run\.js|spawn\(/, name);
  }
});

test('the frozen contract names the Codex source commit and the Claude Code result fields', () => {
  assert.match(CLIENT_METERING_CONTRACT.codex.source, /openai\/codex@067249a28329feec4a097f55413894acb4a6378a/);
  assert.deepEqual(CLIENT_METERING_CONTRACT.codex.fields, Object.keys(CODEX_TURN_COMPLETED.usage));
  assert.deepEqual(CLIENT_METERING_CONTRACT.claudeCode.fields, [
    'input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'
  ]);
});

test('Claude metering reads result.usage and keeps cache reads and writes counted once', () => {
  const metering = claudeMetering(parseJsonLines(stream(
    { type: 'assistant', message: { usage: { input_tokens: 7, output_tokens: 3 }, content: [] } },
    { type: 'assistant', message: { usage: { input_tokens: 9, output_tokens: 5 }, content: [] } },
    'not json',
    claudeResult({
      total_cost_usd: 0.0123456789,
      usage: { input_tokens: 10, cache_read_input_tokens: 80, cache_creation_input_tokens: 5, output_tokens: 12 }
    })
  )));
  // Per-request assistant usage is not added on top of the result.
  assert.deepEqual(metering.usage, {
    inputTokens: 95,
    outputTokens: 12,
    totalTokens: 107,
    cachedInputTokens: 80,
    cacheWriteInputTokens: 5,
    reasoningTokens: null,
    definition: 'claude_code_result_usage'
  });
  assert.deepEqual(metering.cost, { usd: 0.0123456789, source: 'client_reported' });
  assert.deepEqual(metering.notReported, []);
  assert.deepEqual(metering.flags, []);
});

test('Codex metering maps the frozen Usage fields without adding cache or reasoning parts again', () => {
  const metering = codexMetering(parseJsonLines(stream(
    { type: 'thread.started', thread_id: 'fake' },
    CODEX_TURN_COMPLETED
  )));
  assert.deepEqual(metering.reported, CODEX_TURN_COMPLETED.usage);
  assert.deepEqual(metering.usage, {
    inputTokens: 100,
    outputTokens: 10,
    totalTokens: 110,
    cachedInputTokens: 40,
    cacheWriteInputTokens: 60,
    reasoningTokens: 5,
    definition: 'codex_exec_turn_usage'
  });
  // Codex reports no cost: unknown, not free.
  assert.deepEqual(metering.cost, { usd: null, source: null });
  assert.deepEqual(metering.notReported, ['cost']);
});

test('Codex metering replaces cumulative turn snapshots instead of adding them', () => {
  const metering = codexMetering([
    { type: 'turn.completed', usage: { ...CODEX_TURN_COMPLETED.usage, input_tokens: 60 } },
    CODEX_TURN_COMPLETED
  ]);
  assert.equal(metering.usage.inputTokens, 100);
  assert.equal(metering.usage.totalTokens, 110);
});

test('Codex fields outside the frozen contract are not read as aliases', () => {
  const metering = codexMetering([{ type: 'turn.completed', usage: {
    input_tokens: 10, cached_input_tokens: 0, output_tokens: 4, reasoning_tokens: 3
  } }]);
  assert.equal(metering.usage.reasoningTokens, null);
  assert.equal(metering.usage.cacheWriteInputTokens, null);
  assert.deepEqual(metering.notReported, ['cache_write_input_tokens', 'reasoning_output_tokens', 'cost']);
});

test('an explicit 0 stays 0 while missing, null and invalid values stay unknown', () => {
  const zero = claudeMetering([claudeResult({ total_cost_usd: 0, usage: {
    input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0
  } })]);
  assert.equal(zero.usage.inputTokens, 0);
  assert.equal(zero.usage.outputTokens, 0);
  assert.deepEqual(zero.cost, { usd: 0, source: 'client_reported' });

  const unknown = claudeMetering([claudeResult({ total_cost_usd: '0.5', usage: {
    input_tokens: 10, cache_read_input_tokens: null, output_tokens: -1
  } })]);
  assert.equal(unknown.reported.input_tokens, 10);
  assert.equal(unknown.usage.inputTokens, null, 'a missing cache part leaves the whole input unknown');
  assert.equal(unknown.usage.outputTokens, null);
  assert.equal(unknown.usage.totalTokens, null);
  assert.deepEqual(unknown.cost, { usd: null, source: null });
  assert.deepEqual(unknown.notReported, [
    'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens', 'cost'
  ]);

  for (const value of [1.5, Number.MAX_SAFE_INTEGER + 1, '12', Number.NaN]) {
    assert.equal(codexMetering([{ type: 'turn.completed', usage: { input_tokens: value } }]).usage.inputTokens, null);
  }
});

test('a zeroed Claude crash result is unknown, not free', () => {
  const crash = claudeMetering([claudeResult({ subtype: 'error_during_execution', is_error: true, total_cost_usd: 0,
    usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 } })]);
  assert.equal(crash.usage.inputTokens, null);
  assert.equal(crash.cost.usd, null);
  assert.deepEqual(crash.flags, ['zeroed_crash_result']);

  const budget = claudeMetering([claudeResult({ subtype: 'error_max_budget_usd', is_error: true, total_cost_usd: 0.42 })]);
  assert.equal(budget.cost.usd, 0.42);
  assert.deepEqual(budget.flags, []);
  assert.equal(budget.partialTokens, 'budget_stop');
});

function budgetStopThroughReport(usage) {
  const metering = claudeMetering(parseJsonLines(stream(claudeResult({
    subtype: 'error_max_budget_usd', is_error: true, total_cost_usd: 0.42, usage
  }))));
  const ledger = ledgerOf('AGENT-04.fuli', attemptOutcome({ error: 'budget', metering }));
  const json = JSON.parse(JSON.stringify({ run: { claude: { metering: ledger } } })).run.claude.metering;
  return {
    json,
    attemptMarkdown: attemptMeteringMarkdown('fuli', json.attempts[0]),
    totalsMarkdown: meteringTotalsMarkdown('Claude Code', json.totals)
  };
}

test('a budget stop with all-zero usage keeps its cost and reports tokens as a partial subtotal', () => {
  const { json, attemptMarkdown, totalsMarkdown } = budgetStopThroughReport({
    input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0
  });
  const [attempt] = json.attempts;
  assert.equal(attempt.partialTokens, 'budget_stop');
  assert.equal(attempt.usage.inputTokens, 0);
  assert.deepEqual(attempt.cost, { usd: 0.42, source: 'client_reported' });
  assert.deepEqual(json.totals.tokens.inputTokens, {
    knownSubtotal: 0, unknownAttempts: 0, partialAttempts: 1, complete: false
  });
  assert.deepEqual(json.totals.partialTokenAttempts, { budget_stop: 1 });
  assert.equal(json.totals.cost.complete, true);
  assert.equal(json.totals.complete, false);

  assert.match(attemptMarkdown, /输入 token \/ input tokens 已知小计 \/ known subtotal 0（部分：预算中止 \/ budget stop）/);
  assert.match(attemptMarkdown, /费用 \/ cost \$0.42（客户端上报 \/ client-reported）/);
  assert.match(totalsMarkdown, /1 次尝试 \/ attempts；不完整 \/ incomplete/);
  assert.match(totalsMarkdown, /输入 token \/ input tokens：已知小计 \/ known subtotal 0（部分：预算中止 \/ budget stop，1 次 \/ partial attempts）/);
  assert.doesNotMatch(totalsMarkdown, /input tokens：0$/m);
});

test('a budget stop with non-zero usage does not pass its subtotal off as a complete total', () => {
  const { json, attemptMarkdown, totalsMarkdown } = budgetStopThroughReport({
    input_tokens: 3, cache_read_input_tokens: 40, cache_creation_input_tokens: 5, output_tokens: 9
  });
  assert.equal(json.attempts[0].usage.inputTokens, 48);
  assert.deepEqual(json.totals.tokens.outputTokens, {
    knownSubtotal: 9, unknownAttempts: 0, partialAttempts: 1, complete: false
  });
  assert.equal(json.totals.complete, false);
  assert.match(attemptMarkdown, /输出 token \/ output tokens 已知小计 \/ known subtotal 9（部分：预算中止 \/ budget stop）/);
  assert.match(totalsMarkdown, /输入 token \/ input tokens：已知小计 \/ known subtotal 48（部分：预算中止 \/ budget stop，1 次 \/ partial attempts）/);
  assert.match(totalsMarkdown, /费用 \/ cost：已知小计 \/ known subtotal 客户端上报 \/ client-reported \$0.42$/m);
});

test('output text length is never presented as tokens', () => {
  const metering = claudeMetering([{ type: 'result', result: 'x'.repeat(4000) }]);
  assert.equal(metering.usage.inputTokens, null);
  assert.equal(metering.usage.outputTokens, null);
  assert.equal(metering.cost.usd, null);
});

test('usage a client reported before it failed is kept', () => {
  // A failed process hands its partial stdout to the parser.
  const claude = claudeMetering(parseJsonLines(stream(
    claudeResult({ subtype: 'error_max_budget_usd', is_error: true, total_cost_usd: 0.42,
      usage: { input_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 9 } })
  )));
  assert.equal(claude.cost.usd, 0.42);
  assert.equal(claude.usage.outputTokens, 9);

  const codex = codexMetering(parseJsonLines(stream(
    CODEX_TURN_COMPLETED,
    { type: 'turn.failed', error: { message: 'stream disconnected' } }
  )));
  assert.equal(codex.usage.inputTokens, 100);

  assert.equal(codexMetering(parseJsonLines('')).usage.inputTokens, null);
});

test('retries keep every attempt outcome, not just the last result', async () => {
  const fakes = [
    { error: 'stream disconnected', answer: '', metering: codexMetering([
      { type: 'turn.completed', usage: { ...CODEX_TURN_COMPLETED.usage, input_tokens: 40 } }
    ]) },
    { error: null, answer: 'done', metering: codexMetering([CODEX_TURN_COMPLETED]) }
  ];
  const run = await runMeteredAttempts({
    maxAttempts: 2,
    runAttempt: async (number) => fakes[number - 1],
    shouldRetry: ({ error }) => Boolean(error)
  });
  assert.equal(run.answer, 'done');
  assert.equal(run.attempts, 2);
  assert.deepEqual(run.attemptOutcomes.map(({ failed }) => failed), [true, false]);

  const stopped = await runMeteredAttempts({
    maxAttempts: 2,
    runAttempt: async () => fakes[0],
    shouldRetry: () => true
  });
  assert.equal(stopped.attempts, 2, 'the last allowed attempt ends the loop');
});

test('the final JSON keeps a redacted record of a failed attempt and its successful retry', async () => {
  const fakes = [
    { error: 'stream disconnected', answer: '', partialStdout: 'RAW-STDOUT-SECRET', metering: codexMetering(
      parseJsonLines(stream({ type: 'turn.completed', usage: { ...CODEX_TURN_COMPLETED.usage, input_tokens: 40 } }))
    ) },
    { error: null, answer: 'RAW-ANSWER', metering: codexMetering([CODEX_TURN_COMPLETED]) }
  ];
  const run = await runMeteredAttempts({
    maxAttempts: 2,
    runAttempt: async (number) => fakes[number - 1],
    shouldRetry: ({ error }) => Boolean(error)
  });
  const result = { run: { codex: { metering: meteringLedger() } } };
  recordAttempts(result.run.codex.metering, 'NETWORK-CODEX-01.parent-a', run.attemptOutcomes);
  const text = JSON.stringify(result, null, 2);
  const { attempts, totals } = JSON.parse(text).run.codex.metering;

  assert.deepEqual(attempts.map(({ client, callId, attempt, status }) => ({ client, callId, attempt, status })), [
    { client: 'codex', callId: 'NETWORK-CODEX-01.parent-a', attempt: 1, status: 'failed' },
    { client: 'codex', callId: 'NETWORK-CODEX-01.parent-a', attempt: 2, status: 'completed' }
  ]);
  assert.equal(attempts[0].usage.inputTokens, 40);
  assert.equal(attempts[1].reported.cache_write_input_tokens, 60);
  assert.deepEqual(attempts[1].cost, { usd: null, source: null });
  assert.deepEqual(attempts[1].notReported, ['cost']);
  assert.equal(totals.tokens.inputTokens.knownSubtotal, 140);
  assert.equal(totals.tokens.cacheWriteInputTokens.knownSubtotal, 120);
  assert.deepEqual(totals.cost, { knownUsdBySource: {}, unknownAttempts: 2, complete: false });
  for (const raw of ['RAW-STDOUT-SECRET', 'RAW-ANSWER', 'stream disconnected']) {
    assert.equal(text.includes(raw), false, raw);
  }
});

test('totals show the known subtotal, unknown attempts and completeness', () => {
  const known = attemptOutcome({ error: null, metering: claudeMetering([claudeResult({ total_cost_usd: 0.1, usage: {
    input_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 3, output_tokens: 4
  } })]) });
  const unknown = attemptOutcome({ error: 'failed', metering: claudeMetering([]) });
  const { totals } = ledgerOf('AGENT-04.fuli', known, unknown, known);
  assert.equal(totals.attempts, 3);
  assert.deepEqual(totals.tokens.inputTokens, { knownSubtotal: 12, unknownAttempts: 1, partialAttempts: 0, complete: false });
  assert.deepEqual(totals.tokens.reasoningTokens, { knownSubtotal: null, unknownAttempts: 3, partialAttempts: 0, complete: false });
  assert.deepEqual(totals.cost, { knownUsdBySource: { client_reported: 0.2 }, unknownAttempts: 1, complete: false });
  assert.equal(totals.complete, false);

  const allUnknown = ledgerOf('AGENT-05.unrelated', unknown, unknown).totals;
  assert.equal(allUnknown.tokens.inputTokens.knownSubtotal, null);
  assert.deepEqual(allUnknown.cost.knownUsdBySource, {});

  const none = meteringLedger().totals;
  assert.deepEqual(none.tokens.inputTokens, { knownSubtotal: 0, unknownAttempts: 0, partialAttempts: 0, complete: true });
  assert.equal(none.attempts, 0);
});

test('roundMoney keeps unknown money unknown', () => {
  assert.equal(roundMoney(null), null);
  assert.equal(roundMoney(undefined), null);
  assert.equal(roundMoney(Number.NaN), null);
  assert.equal(roundMoney(0), 0);
  assert.equal(roundMoney(0.1 + 0.2), 0.3);
});

test('JSON and Markdown say not reported instead of 0', () => {
  const unknown = codexMetering([]);
  const json = JSON.parse(JSON.stringify(unknown));
  assert.equal(json.usage.inputTokens, null);
  assert.equal(json.cost.usd, null);
  assert.ok(json.notReported.includes('input_tokens'));
  assert.ok(json.notReported.includes('cost'));

  const attempt = attemptMeteringMarkdown('baseline', unknown);
  assert.match(attempt, new RegExp(`输入 token / input tokens ${NOT_REPORTED}`));
  assert.match(attempt, new RegExp(`费用 / cost ${NOT_REPORTED}`));
  assert.doesNotMatch(attempt, /\b0\b/);

  const zero = attemptMeteringMarkdown('fuli', claudeMetering([claudeResult({ total_cost_usd: 0, usage: {
    input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0
  } })]));
  assert.match(zero, /输入 token \/ input tokens 0；/);
  assert.match(zero, /费用 \/ cost \$0（客户端上报 \/ client-reported）/);

  const { totals } = ledgerOf(
    'AGENT-04.baseline',
    attemptOutcome({ error: null, metering: claudeMetering([claudeResult()]) }),
    attemptOutcome({ error: 'failed', metering: claudeMetering([]) })
  );
  const markdown = meteringTotalsMarkdown('Claude Code', totals);
  assert.match(markdown, /2 次尝试 \/ attempts；不完整 \/ incomplete/);
  assert.match(markdown, new RegExp(`输入 token / input tokens：已知小计 / known subtotal 1；另 1 次${NOT_REPORTED}`));
  assert.match(markdown, new RegExp(`其中推理 / of which reasoning：${NOT_REPORTED}（2 次 / attempts）`));
  assert.match(markdown, new RegExp(`费用 / cost：已知小计 / known subtotal 客户端上报 / client-reported \\$0.25；另 1 次${NOT_REPORTED}`));

  assert.equal(meteringTotalsMarkdown('Codex', meteringLedger().totals), '- **Codex**：未运行 / not run');
  assert.match(meteringTotalsMarkdown('Codex', undefined), /未记录计量 \/ metering not recorded/);
});
