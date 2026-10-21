import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  claudeMetering,
  codexMetering,
  meteringTotals,
  parseJsonLines,
  roundMoney,
  runMeteredAttempts
} from '../acceptance/alignment/client-metering.js';
import {
  attemptMeteringMarkdown,
  meteringTotalsMarkdown
} from '../acceptance/alignment/metering-report.js';

const stream = (...events) => events.map((event) => JSON.stringify(event)).join('\n');
const NOT_REPORTED = '未上报 / not reported';

test('the metering modules parse fakes and can never start a client', () => {
  for (const name of ['client-metering.js', 'metering-report.js']) {
    const source = readFileSync(new URL(`../acceptance/alignment/${name}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /child_process|\.\/run\.js|spawn\(/, name);
  }
});

test('Claude metering reads result.usage and keeps cache reads and writes counted once', () => {
  const metering = claudeMetering(parseJsonLines(stream(
    { type: 'assistant', message: { usage: { input_tokens: 7, output_tokens: 3 }, content: [] } },
    { type: 'assistant', message: { usage: { input_tokens: 9, output_tokens: 5 }, content: [] } },
    'not json',
    {
      type: 'result',
      total_cost_usd: 0.0123456789,
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 80,
        cache_creation_input_tokens: 5,
        output_tokens: 12
      }
    }
  )));
  // Per-request assistant usage is not added on top of the session result.
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
});

test('Codex metering keeps cached input inside input and replaces cumulative turn snapshots', () => {
  const metering = codexMetering(parseJsonLines(stream(
    { type: 'thread.started', thread_id: 'fake' },
    { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10 } },
    { type: 'turn.completed', usage: { input_tokens: 160, cached_input_tokens: 120, output_tokens: 25 } }
  )));
  assert.equal(metering.usage.inputTokens, 160);
  assert.equal(metering.usage.cachedInputTokens, 120);
  assert.equal(metering.usage.outputTokens, 25);
  assert.equal(metering.usage.totalTokens, 185);
  assert.equal(metering.usage.reasoningTokens, null);
  // Codex reports no cost: unknown, not free.
  assert.deepEqual(metering.cost, { usd: null, source: null });
  assert.deepEqual(metering.notReported, ['reasoning_tokens', 'cost']);
});

test('an explicit 0 stays 0 while missing, null and invalid values stay unknown', () => {
  const zero = claudeMetering([{ type: 'result', total_cost_usd: 0, usage: {
    input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0
  } }]);
  assert.equal(zero.usage.inputTokens, 0);
  assert.equal(zero.usage.outputTokens, 0);
  assert.deepEqual(zero.cost, { usd: 0, source: 'client_reported' });

  const unknown = claudeMetering([{ type: 'result', total_cost_usd: '0.5', usage: {
    input_tokens: 10, cache_read_input_tokens: null, output_tokens: -1
  } }]);
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

test('output text length is never presented as tokens', () => {
  const metering = claudeMetering([{ type: 'result', result: 'x'.repeat(4000) }]);
  assert.equal(metering.usage.inputTokens, null);
  assert.equal(metering.usage.outputTokens, null);
  assert.equal(metering.cost.usd, null);
});

test('usage a client reported before it failed is kept', () => {
  // A failed process hands its partial stdout to the parser.
  const claude = claudeMetering(parseJsonLines(stream(
    { type: 'result', is_error: true, subtype: 'error_max_budget_usd', total_cost_usd: 0.42,
      usage: { input_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 9 } }
  )));
  assert.equal(claude.cost.usd, 0.42);
  assert.equal(claude.usage.outputTokens, 9);

  const codex = codexMetering(parseJsonLines(stream(
    { type: 'turn.completed', usage: { input_tokens: 50, cached_input_tokens: 0, output_tokens: 4 } },
    { type: 'turn.failed', error: { message: 'stream disconnected' } }
  )));
  assert.equal(codex.usage.inputTokens, 50);
  assert.equal(codex.usage.cachedInputTokens, 0);

  const nothing = codexMetering(parseJsonLines(''));
  assert.equal(nothing.usage.inputTokens, null);
});

test('retries keep every attempt metering, not just the last result', async () => {
  const fakes = [
    { error: 'stream disconnected', metering: codexMetering([
      { type: 'turn.completed', usage: { input_tokens: 40, cached_input_tokens: 10, output_tokens: 2 } }
    ]) },
    { error: null, answer: 'done', metering: codexMetering([
      { type: 'turn.completed', usage: { input_tokens: 60, cached_input_tokens: 20, output_tokens: 8 } }
    ]) }
  ];
  const run = await runMeteredAttempts({
    maxAttempts: 2,
    runAttempt: async (number) => fakes[number - 1],
    shouldRetry: ({ error }) => Boolean(error)
  });
  assert.equal(run.answer, 'done');
  assert.equal(run.attempts, 2);
  assert.equal(run.attemptMetering.length, 2);
  const totals = meteringTotals(run.attemptMetering);
  assert.equal(totals.tokens.inputTokens.knownSubtotal, 100);
  assert.equal(totals.tokens.cachedInputTokens.knownSubtotal, 30);
  assert.equal(totals.tokens.outputTokens.knownSubtotal, 10);

  const stopped = await runMeteredAttempts({
    maxAttempts: 2,
    runAttempt: async () => fakes[0],
    shouldRetry: () => true
  });
  assert.equal(stopped.attempts, 2, 'the last allowed attempt ends the loop');
});

test('totals show the known subtotal, unknown attempts and completeness', () => {
  const known = claudeMetering([{ type: 'result', total_cost_usd: 0.1, usage: {
    input_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 3, output_tokens: 4
  } }]);
  const unknown = claudeMetering([]);
  const totals = meteringTotals([known, unknown, known]);
  assert.equal(totals.attempts, 3);
  assert.deepEqual(totals.tokens.inputTokens, { knownSubtotal: 12, unknownAttempts: 1, complete: false });
  assert.deepEqual(totals.tokens.reasoningTokens, { knownSubtotal: null, unknownAttempts: 3, complete: false });
  assert.deepEqual(totals.cost, {
    knownUsdBySource: { client_reported: 0.2 },
    unknownAttempts: 1,
    complete: false
  });
  assert.equal(totals.complete, false);

  const allUnknown = meteringTotals([unknown, unknown]);
  assert.equal(allUnknown.tokens.inputTokens.knownSubtotal, null);
  assert.deepEqual(allUnknown.cost.knownUsdBySource, {});

  const none = meteringTotals([]);
  assert.deepEqual(none.tokens.inputTokens, { knownSubtotal: 0, unknownAttempts: 0, complete: true });
  assert.equal(none.complete, true);
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

  const zero = attemptMeteringMarkdown('fuli', claudeMetering([{ type: 'result', total_cost_usd: 0, usage: {
    input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0
  } }]));
  assert.match(zero, /输入 token \/ input tokens 0；/);
  assert.match(zero, /费用 \/ cost \$0（客户端上报 \/ client-reported）/);

  const known = claudeMetering([{ type: 'result', total_cost_usd: 0.25, usage: {
    input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 2
  } }]);
  const totals = meteringTotalsMarkdown('Claude Code', meteringTotals([known, codexMetering([])]));
  assert.match(totals, /2 次尝试 \/ attempts；不完整 \/ incomplete/);
  assert.match(totals, new RegExp(`输入 token / input tokens：已知小计 / known subtotal 1；另 1 次${NOT_REPORTED}`));
  assert.match(totals, new RegExp(`其中推理 / of which reasoning：${NOT_REPORTED}（2 次 / attempts）`));
  assert.match(totals, new RegExp(`费用 / cost：已知小计 / known subtotal 客户端上报 / client-reported \\$0.25；另 1 次${NOT_REPORTED}`));

  assert.match(meteringTotalsMarkdown('Codex', undefined), /未记录计量 \/ metering not recorded/);
});
