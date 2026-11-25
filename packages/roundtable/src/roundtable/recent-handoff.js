// What a normal FLA-to-FLA ask carries about the sender's own finished work:
// enough for the next FLA to know what was done, what proves it and what is
// still open, and small enough that it stays an index. It belongs to the ask,
// so a recipient that is already running, or that restarts, reads the same
// handoff from its inbox.
export const HANDOFF_WINDOW_MS = 48 * 60 * 60 * 1000;
export const HANDOFF_MAX_ROWS = 10;
export const HANDOFF_MAX_BYTES = 2400;

// The sender's last few finished tasks and the open ones it leaves behind.
const COMPLETED_LIMIT = 3;
const REMAINING_LIMIT = 3;
const TASK_ID_CHARS = 120;
const TITLE_CHARS = 90;
const SUMMARY_CHARS = 220;
const EVIDENCE_CHARS = 140;
const SOURCE_CHARS = 32;
const ACTOR_CHARS = 80;

// One bounded handoff of the sender's completed work in one project, or null.
// A host without the method, a failed read and an empty window all leave the
// ask as it was; nothing is invented to fill the block. bound marks a task the
// caller named explicitly: if it cannot be read or is not the sender's, the
// reader returns nothing rather than substituting other work.
export async function handoffFor(host, { agentId, agentName = null, projectId, taskId = null,
  bound = false, asOf = Date.now(), enabled = true } = {}) {
  if (!enabled || !agentId || !projectId || typeof host?.handoff !== 'function') return null;
  const at = Number.isFinite(asOf) ? asOf : Date.now();
  const since = new Date(at - HANDOFF_WINDOW_MS).toISOString();
  let value;
  try {
    value = await host.handoff({ agentId, projectId, taskId, bound, since, until: new Date(at).toISOString(),
      limit: HANDOFF_MAX_ROWS });
  } catch { return null; }
  if (!value || value.status === 'unavailable') return null;
  return boundedHandoff(value, { at, since, agentId, agentName, projectId });
}

// The compact block a recipient reads in its inbox and wake prompt, or ''. The
// rendered text is capped with the actual space id it is rendered with: the
// optional read hint is dropped first, then rows (each counted in omitted).
export function handoffText(handoff, { spaceId = '' } = {}) {
  if (!handoff) return '';
  const full = renderHandoff(handoff, spaceId);
  if (Buffer.byteLength(full) <= HANDOFF_MAX_BYTES) return full;
  // The expansion hint is an aid, not data, so it goes before any row.
  const hintless = renderHandoff(handoff, '');
  if (Buffer.byteLength(hintless) <= HANDOFF_MAX_BYTES) return hintless;
  const trimmed = { ...handoff, completed: [...(handoff.completed ?? [])],
    remaining: [...(handoff.remaining ?? [])] };
  while (rowsOf(trimmed) > 0) {
    if (trimmed.remaining.length) trimmed.remaining.pop();
    else trimmed.completed.pop();
    trimmed.omitted = (trimmed.omitted ?? 0) + 1;
    const text = renderHandoff(trimmed, '');
    if (Buffer.byteLength(text) <= HANDOFF_MAX_BYTES) return text;
  }
  return fitBytes(renderHandoff(trimmed, ''), HANDOFF_MAX_BYTES);
}

// The block without the byte cap, for the cap and the stored bound.
function renderHandoff(handoff, spaceId) {
  const from = clip(handoff.from?.name, ACTOR_CHARS) || handoff.from?.agentId || '上一位 FLA';
  const header = `接手交接：${from} ${handoff.completed?.length ? '已完成的工作' : '留下的工作'}`
    + '（同一项目，近 48 小时，最多 10 条；请接着做）';
  const completed = (handoff.completed ?? []).map(row => {
    const proof = [row.taskId ? `task ${row.taskId}` : null, row.evidence,
      row.source ? `source ${row.source}` : null].filter(Boolean).join('；');
    return `- 已完成 ${timeLabel(row.at)} · ${row.title || row.summary || row.taskId}`
      + (proof ? ` [${proof}]` : '')
      + (row.title && row.summary ? `\n  结果：${row.summary}` : '');
  });
  const remaining = handoff.remaining?.length
    ? `待接手：${handoff.remaining.map(row => `${row.title || row.taskId}（${row.status || '未完成'}，task ${row.taskId}）`).join('；')}`
    : null;
  const omitted = handoff.omitted > 0 ? `另有 ${handoff.omitted} 条未列出。` : null;
  const read = readHint(handoff, spaceId);
  return [header, ...completed, remaining, omitted, read].filter(Boolean).join('\n');
}

// The exact calls that expand the index, with the keys the tools require.
function readHint(handoff, spaceId) {
  const first = handoff.completed?.[0]?.taskId ?? handoff.remaining?.[0]?.taskId;
  // Without a space id the concrete call could not name a scope the tools accept.
  if (!first || !spaceId) return null;
  const space = `personalSpaceId=${JSON.stringify(spaceId)}`;
  return `读全量：view_project_agent_task(${space}, taskId=${JSON.stringify(first)})；`
    + `list_project_agent_tasks(${space}, personalProjectId=${JSON.stringify(handoff.projectId)}, `
    + `agentId=${JSON.stringify(handoff.from.agentId)})`;
}

function boundedHandoff(value, { at, since, agentId, agentName, projectId }) {
  const seen = new Set();
  const rows = (items, limit) => (Array.isArray(items) ? items : [])
    .map(item => handoffRow(item, { since, at, seen }))
    .filter(Boolean)
    .slice(0, limit);
  const completed = rows(value.completed, COMPLETED_LIMIT);
  const remaining = rows(value.remaining, REMAINING_LIMIT);
  if (!completed.length && !remaining.length) return null;
  const payload = {
    v: 1,
    at: new Date(at).toISOString(),
    from: { agentId, name: agentName ? clip(agentName, ACTOR_CHARS) : null },
    projectId,
    sourceTaskId: completed[0]?.taskId ?? null,
    completed,
    remaining,
    omitted: Number.isInteger(value.omitted) && value.omitted > 0 ? value.omitted : 0
  };
  // Keep the stored payload inside 10 rows and 2400 UTF-8 bytes, whatever the
  // source wrote: drop the open rows first, then the oldest finished ones, and
  // count every dropped row instead of hiding it. The optional read hint is not
  // part of the stored data; handoffText drops it when the actual space id
  // would make the block too long.
  while (rowsOf(payload) > 1 && !fits(payload)) {
    if (payload.remaining.length) payload.remaining = payload.remaining.slice(0, -1);
    else payload.completed = payload.completed.slice(0, -1);
    payload.omitted += 1;
  }
  return fits(payload) ? payload : null;
}

const rowsOf = handoff => (handoff.completed?.length ?? 0) + (handoff.remaining?.length ?? 0);

function fits(handoff) {
  return Buffer.byteLength(JSON.stringify(handoff)) <= HANDOFF_MAX_BYTES
    && Buffer.byteLength(renderHandoff(handoff, '')) <= HANDOFF_MAX_BYTES;
}

function handoffRow(row, { since, at, seen }) {
  if (!row || typeof row !== 'object') return null;
  const taskId = typeof row.taskId === 'string' ? row.taskId.trim() : '';
  if (!taskId || [...taskId].length > TASK_ID_CHARS || seen.has(taskId)) return null;
  const when = Date.parse(row.at);
  // A future instant is not evidence of work done, and a stale one is not a handoff.
  if (!Number.isFinite(when) || when < since || when > at) return null;
  seen.add(taskId);
  return {
    taskId,
    title: clip(row.title, TITLE_CHARS) || null,
    status: clip(row.status, 32) || null,
    at: new Date(when).toISOString(),
    summary: clip(row.summary, SUMMARY_CHARS) || null,
    evidence: clip(row.evidence, EVIDENCE_CHARS) || null,
    source: clip(row.source, SOURCE_CHARS) || null
  };
}

function timeLabel(at) {
  return `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

// A last-resort cap that never splits a code point or a UTF-8 sequence.
function fitBytes(text, maxBytes) {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const suffix = '…';
  const budget = maxBytes - Buffer.byteLength(suffix);
  if (budget <= 0) return '';
  let used = 0;
  let out = '';
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (used + size > budget) break;
    out += character;
    used += size;
  }
  return `${out.trimEnd()}${suffix}`;
}

// Cut by Unicode code points (never through a surrogate pair), one line.
function clip(value, limit) {
  const text = String(value ?? '').replace(/[\r\n\t]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  const characters = [...text];
  return characters.length > limit ? `${characters.slice(0, limit - 1).join('').trimEnd()}…` : text;
}
