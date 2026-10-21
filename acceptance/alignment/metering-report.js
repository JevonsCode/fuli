import { roundMoney } from './client-metering.js';

// Markdown for client metering. An unknown value reads 未上报 / not reported,
// never 0; a known 0 reads 0.

const NOT_REPORTED = '未上报 / not reported';

const NOT_RECORDED = '未记录计量 / metering not recorded';
const NOT_RUN = '未运行 / not run';
const TOKEN_LABELS = Object.freeze([
  ['inputTokens', '输入 token / input tokens'],
  ['cachedInputTokens', '其中缓存读取 / of which cache reads'],
  ['cacheWriteInputTokens', '其中缓存写入 / of which cache writes'],
  ['outputTokens', '输出 token / output tokens'],
  ['reasoningTokens', '其中推理 / of which reasoning']
]);
const COST_SOURCE_LABELS = Object.freeze({
  client_reported: '客户端上报 / client-reported'
});

export function meteringTotalsMarkdown(label, totals) {
  if (!totals) return `- **${label}**：${NOT_RECORDED}`;
  if (!totals.attempts) return `- **${label}**：${NOT_RUN}`;
  const completeness = totals.complete ? '完整 / complete' : '不完整 / incomplete';
  return [
    `- **${label}**：${totals.attempts} 次尝试 / attempts；${completeness}`,
    ...TOKEN_LABELS.map(([field, name]) => `  - ${name}：${subtotalText(totals.tokens[field])}`),
    `  - 费用 / cost：${costSubtotalText(totals.cost)}`
  ].join('\n');
}

export function attemptMeteringMarkdown(label, metering) {
  if (!metering) return `- **${label}**：${NOT_RECORDED}`;
  const tokens = TOKEN_LABELS
    .map(([field, name]) => `${name} ${valueText(metering.usage[field])}`)
    .join('；');
  return `- **${label}**：${tokens}；费用 / cost ${costText(metering.cost)}`;
}

function subtotalText({ knownSubtotal, unknownAttempts }) {
  if (knownSubtotal === null) return `${NOT_REPORTED}（${unknownAttempts} 次 / attempts）`;
  return unknownAttempts
    ? `已知小计 / known subtotal ${knownSubtotal}；另 ${unknownAttempts} 次${NOT_REPORTED}`
    : String(knownSubtotal);
}

function costSubtotalText({ knownUsdBySource, unknownAttempts }) {
  const known = Object.entries(knownUsdBySource)
    .map(([source, value]) => `${sourceLabel(source)} $${value}`);
  if (!known.length) return `${NOT_REPORTED}（${unknownAttempts} 次 / attempts）`;
  const unknown = unknownAttempts ? `；另 ${unknownAttempts} 次${NOT_REPORTED}` : '';
  return `已知小计 / known subtotal ${known.join('，')}${unknown}`;
}

function costText({ usd, source }) {
  const value = roundMoney(usd);
  return value === null ? NOT_REPORTED : `$${value}（${sourceLabel(source)}）`;
}

function valueText(value) {
  return value === null ? NOT_REPORTED : String(value);
}

function sourceLabel(source) {
  return COST_SOURCE_LABELS[source] ?? source;
}
