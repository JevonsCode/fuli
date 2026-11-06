#!/usr/bin/env node
// Turns run.js records into the curve: per session and arm the median and the range (min–max) across reps of
// all input + output, model requests and exploration calls, the pass count, and per arm the headline "tokens per
// passed task" (every session's tokens divided by the sessions that passed their hidden check).
//   node acceptance/compounding-sessions/summarize.js --out <dir> --tag base [--off-tag base,extra] [--json <file>]
// --tag and --off-tag take comma-separated tags; --off-tag (default: --tag) is where the off arm is read from.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { out: { type: 'string' }, tag: { type: 'string', default: 'base' },
  'off-tag': { type: 'string' }, json: { type: 'string' } } });
const read = (tags) => tags.split(',').flatMap((tag) => {
  const dir = join(resolve(values.out), 'results', tag);
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8'))) : [];
});

const tokens = (r) => (r.usage.allInput ?? 0) + (r.usage.output ?? 0);
const sorted = (xs) => xs.filter(Number.isFinite).sort((a, b) => a - b);
export function median(xs) {
  const s = sorted(xs);
  if (!s.length) return null;
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}
const range = (xs) => { const s = sorted(xs); return s.length ? [s[0], s.at(-1)] : [null, null]; };
const spread = (xs) => ({ median: median(xs), range: range(xs), n: sorted(xs).length });

export function summarize(records) {
  const arms = ['off', 'fuli'].filter((arm) => records.some((r) => r.arm === arm));
  const sessions = [...new Set(records.map((r) => r.session))].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  const perSession = sessions.map((session) => ({
    session,
    title: records.find((r) => r.session === session)?.title,
    arms: Object.fromEntries(arms.map((arm) => {
      const rs = records.filter((r) => r.arm === arm && r.session === session);
      return [arm, { n: rs.length, passed: rs.filter((r) => r.success).length, tokens: spread(rs.map(tokens)),
        requests: spread(rs.map((r) => r.modelRequests)), explore: spread(rs.map((r) => r.tools.explore)),
        hookBytes: median(rs.map((r) => r.hooks.promptContextBytes)) }];
    }))
  }));
  const perArm = Object.fromEntries(arms.map((arm) => {
    const rs = records.filter((r) => r.arm === arm);
    const passed = rs.filter((r) => r.success).length;
    const total = rs.reduce((sum, r) => sum + tokens(r), 0);
    return [arm, { sessions: rs.length, passed, tokens: total, costUsd: rs.reduce((sum, r) => sum + (r.costUsd ?? 0), 0),
      tokensPerPassed: passed ? total / passed : null, costPerPassed: passed ? rs.reduce((sum, r) => sum + (r.costUsd ?? 0), 0) / passed : null,
      sessionTokens: spread(rs.map(tokens)) }];
  }));
  return { arms, perSession, perArm };
}

const k = (n) => (n == null ? '-' : `${Math.round(n / 1000)}k`);
const cell = ({ median: m, range: [lo, hi] }) => (m == null ? '-' : `${k(m)} (${k(lo)}–${k(hi)})`);
const small = ({ median: m, range: [lo, hi] }) => (m == null ? '-' : `${m} (${lo}–${hi})`);

function markdown({ arms, perSession, perArm }) {
  const lines = [`| Session | ${arms.map((a) => `${a} tokens, median (range)`).join(' | ')} | fuli / off | ${arms.map((a) => `${a} requests`).join(' | ')} | ${arms.map((a) => `${a} passed`).join(' | ')} |`,
    `| --- |${' ---: |'.repeat(arms.length * 3 + 1)}`];
  for (const row of perSession) {
    const a = (arm) => row.arms[arm];
    const ratio = a('off')?.tokens.median && a('fuli')?.tokens.median ? `${(a('fuli').tokens.median / a('off').tokens.median).toFixed(2)}×` : '-';
    lines.push(`| ${row.session} ${row.title} | ${arms.map((arm) => cell(a(arm).tokens)).join(' | ')} | ${ratio} | `
      + `${arms.map((arm) => small(a(arm).requests)).join(' | ')} | ${arms.map((arm) => `${a(arm).passed}/${a(arm).n}`).join(' | ')} |`);
  }
  lines.push('', '| Arm | Passed | Tokens per passed task | Session tokens, median (range) | Cost per passed task |', '| --- | ---: | ---: | ---: | ---: |');
  for (const arm of arms) {
    const t = perArm[arm];
    lines.push(`| ${arm} | ${t.passed}/${t.sessions} | ${k(t.tokensPerPassed)} | ${cell(t.sessionTokens)} | ${t.costPerPassed == null ? '-' : `$${t.costPerPassed.toFixed(4)}`} |`);
  }
  return lines.join('\n');
}

const records = [...read(values.tag).filter((r) => r.arm === 'fuli'), ...read(values['off-tag'] ?? values.tag).filter((r) => r.arm === 'off')];
const summary = summarize(records);
if (values.json) writeFileSync(values.json, `${JSON.stringify(summary, null, 2)}\n`);
console.log(markdown(summary));
