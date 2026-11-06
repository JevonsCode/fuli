#!/usr/bin/env node
// Turns run.js records into the curve: per session and arm, medians across reps, and per arm the headline
// "tokens per successful task" (all input + output over every session, divided by the sessions that passed their
// hidden check).
//   node acceptance/compounding-sessions/summarize.js --out <dir> --tag base [--json <file>]
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { out: { type: 'string' }, tag: { type: 'string', default: 'base' }, json: { type: 'string' } } });
const dir = join(resolve(values.out), 'results', values.tag);
const records = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));

const median = (xs) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return null;
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const sum = (xs) => xs.reduce((a, x) => a + (Number.isFinite(x) ? x : 0), 0);
const k = (n) => (n == null ? '-' : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));
const usd = (n) => (n == null ? '-' : `$${n.toFixed(3)}`);
const tokens = (r) => (r.usage.allInput ?? 0) + (r.usage.output ?? 0);

export function summarize(list) {
  const arms = [...new Set(list.map((r) => r.arm))].sort().reverse();
  const sessions = [...new Set(list.map((r) => r.session))].sort();
  const cell = (arm, session) => list.filter((r) => r.arm === arm && r.session === session);
  const perSession = sessions.map((session) => ({
    session,
    title: list.find((r) => r.session === session)?.title,
    arms: Object.fromEntries(arms.map((arm) => {
      const rs = cell(arm, session);
      return [arm, {
        n: rs.length,
        success: rs.filter((r) => r.success).length,
        allInput: median(rs.map((r) => r.usage.allInput)),
        cacheRead: median(rs.map((r) => r.usage.cacheRead)),
        output: median(rs.map((r) => r.usage.output)),
        costUsd: median(rs.map((r) => r.costUsd)),
        modelRequests: median(rs.map((r) => r.modelRequests)),
        toolCalls: median(rs.map((r) => r.tools.total)),
        explore: median(rs.map((r) => r.tools.explore)),
        runs: median(rs.map((r) => r.tools.run)),
        failedRuns: median(rs.map((r) => r.tools.failedRuns)),
        fuliCalls: median(rs.map((r) => r.tools.fuli)),
        hookBytes: median(rs.map((r) => r.hooks.promptContextBytes)),
        secs: median(rs.map((r) => r.secs))
      }];
    }))
  }));
  const perArm = Object.fromEntries(arms.map((arm) => {
    const rs = list.filter((r) => r.arm === arm);
    const successes = rs.filter((r) => r.success).length;
    return [arm, {
      sessions: rs.length, successes,
      allInput: sum(rs.map((r) => r.usage.allInput)), output: sum(rs.map((r) => r.usage.output)),
      costUsd: sum(rs.map((r) => r.costUsd)), toolCalls: sum(rs.map((r) => r.tools.total)),
      explore: sum(rs.map((r) => r.tools.explore)), modelRequests: sum(rs.map((r) => r.modelRequests)),
      tokensPerSuccess: successes ? sum(rs.map(tokens)) / successes : null,
      costPerSuccess: successes ? sum(rs.map((r) => r.costUsd)) / successes : null
    }];
  }));
  return { arms, perSession, perArm };
}

function markdown({ arms, perSession, perArm }) {
  const lines = [];
  lines.push(`| Session | ${arms.map((a) => `${a} all input`).join(' | ')} | fuli / off | ${arms.map((a) => `${a} cost`).join(' | ')} | ${arms.map((a) => `${a} requests`).join(' | ')} | ${arms.map((a) => `${a} tools (explore)`).join(' | ')} | ${arms.map((a) => `${a} pass`).join(' | ')} | fuli hook |`);
  lines.push(`| --- |${' ---: |'.repeat(arms.length * 5 + 2)}`);
  for (const row of perSession) {
    const a = (arm, f) => row.arms[arm]?.[f];
    const ratio = a('off', 'allInput') && a('fuli', 'allInput') ? `${(a('fuli', 'allInput') / a('off', 'allInput')).toFixed(2)}×` : '-';
    lines.push(`| ${row.session} ${row.title} | ${arms.map((arm) => k(a(arm, 'allInput'))).join(' | ')} | ${ratio} | `
      + `${arms.map((arm) => usd(a(arm, 'costUsd'))).join(' | ')} | ${arms.map((arm) => a(arm, 'modelRequests') ?? '-').join(' | ')} | `
      + `${arms.map((arm) => `${a(arm, 'toolCalls') ?? '-'} (${a(arm, 'explore') ?? '-'})`).join(' | ')} | `
      + `${arms.map((arm) => `${a(arm, 'success')}/${a(arm, 'n')}`).join(' | ')} | ${k(a('fuli', 'hookBytes'))}B |`);
  }
  lines.push('');
  lines.push('| Arm | Sessions passed | All input | Output | Cost | Requests | Tool calls (explore) | Tokens per passed task | Cost per passed task |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const arm of arms) {
    const t = perArm[arm];
    lines.push(`| ${arm} | ${t.successes}/${t.sessions} | ${k(t.allInput)} | ${k(t.output)} | ${usd(t.costUsd)} | ${t.modelRequests} | `
      + `${t.toolCalls} (${t.explore}) | ${k(t.tokensPerSuccess)} | ${usd(t.costPerSuccess)} |`);
  }
  return lines.join('\n');
}

const summary = summarize(records);
if (values.json) writeFileSync(values.json, `${JSON.stringify(summary, null, 2)}\n`);
console.log(markdown(summary));
