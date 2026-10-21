import { receiptConsoleUrl, receiptText } from './identity-receipt.js';

// The per-turn receipt (rec#20): after a turn's checkpoint saved knowledge, the
// reply tail lists every item that turn actually created or replaced, read back
// from the Provider after it was saved, never from what the model said it saved.
// One short line per item: new or updated, category, content, actual scope,
// weight and what it rests on (or none), attached tags, source and confirmation,
// and a link to that item's quick edit. Nothing saved, a duplicate, a plain
// conversation archive or a usage-only weight change adds nothing at all.

// What the receipt may add to one reply. Past it, the rest is counted and linked.
const MAX_RECEIPT_CHARS = 1800;
const CONTENT_CHARS = 60;
// The Provider reads one turn's episodes at a time (one per capture scope).
const EPISODES_PER_READ = 3;
const CATEGORY = Object.freeze({ taste: '品味', judgment: '判断', personality: '协作性格', rule: '规则类',
  experience: '经验', fact: '事实', knowledge: '知识' });
const CONFIRMATION = Object.freeze({ pending: '待确认', agent_confirmed: 'Agent已确认', confirmed: '你已确认' });
const SOURCE = Object.freeze({ user_explicit: '你明确说的', agent_inferred: 'Agent推断' });

function knowledgeItemEditUrl(application, itemKind, itemId) {
  const space = encodeURIComponent(application.config.personal.spaceId);
  return `${receiptConsoleUrl(application)}/knowledge/item/${space}/${itemKind}/${encodeURIComponent(itemId)}`;
}

function turnReceiptListUrl(application, episodeIds) {
  const space = encodeURIComponent(application.config.personal.spaceId);
  return `${receiptConsoleUrl(application)}/knowledge/turn/${space}?episodes=${episodeIds.map(encodeURIComponent).join(',')}`;
}

// The receipt of saved capture results: null when nothing substantive changed.
// memory is the Agent working-memory write this checkpoint made, if any.
export async function readTurnReceipt(application, captureResults, { memory = null, agentName = null,
  heading = '本轮沉淀' } = {}) {
  const episodeIds = savedEpisodeIds(captureResults);
  const { entries } = episodeIds.length ? await readEpisodeReceipts(application, episodeIds) : { entries: [] };
  const lines = entries.map(entry => entryLine(application, entry));
  if (memory) lines.push(memoryLine(application, memory, agentName));
  return lines.length ? boundedReceipt(application, heading, lines, episodeIds) : null;
}

// What the episodes created or replaced, read in the Provider's batches and
// merged, so a late receipt of several turns and its full list read the same.
export async function readEpisodeReceipts(application, episodeIds) {
  const entries = new Map();
  let unchanged = 0;
  for (let start = 0; start < episodeIds.length; start += EPISODES_PER_READ) {
    const read = await application.personal.readTurnReceipt({ personal_space_id: application.config.personal.spaceId,
      episode_ids: episodeIds.slice(start, start + EPISODES_PER_READ) });
    if (!Array.isArray(read?.entries)) throw new TypeError('Provider did not return the turn receipt');
    for (const entry of read.entries) entries.set(`${entry.item_kind}:${entry.item_id}`, entry);
    unchanged += read.unchanged_count ?? 0;
  }
  return { entries: [...entries.values()], unchanged_count: unchanged };
}

// Said instead when the knowledge was saved but its receipt could not be read
// or claimed: it stays unread and the session's next entry delivers it once.
export function deferredTurnReceipt() {
  return { lines: ['FULI 本轮沉淀：已保存，回执暂未读取，下一轮补发'], summary: { status: 'deferred' } };
}

// Every task capture's idempotency key carries its task token, so a duplicate
// is this same turn's earlier attempt (it saved, then the checkpoint failed):
// still this turn's receipt. A later turn saving the same words commits a new
// episode, whose read-back reports the items unchanged and lists nothing.
export function savedEpisodeIds(captureResults) {
  return [...new Set((captureResults ?? []).filter(result => ['committed', 'duplicate'].includes(result.status))
    .map(result => result.episode_id).filter(Boolean))];
}

function boundedReceipt(application, heading, lines, episodeIds) {
  const shown = [];
  let used = 0;
  for (const line of lines) {
    if (shown.length && used + line.length > MAX_RECEIPT_CHARS) break;
    shown.push(line);
    used += line.length + 1;
  }
  const omitted = lines.length - shown.length;
  const listUrl = episodeIds.length ? turnReceiptListUrl(application, episodeIds) : null;
  return {
    lines: [`FULI ${heading} ${lines.length} 条：`, ...shown,
      ...(omitted ? [`另 ${omitted} 条未列出：${listUrl ? `[查看全部](<${listUrl}>)` : '见控制台知识页'}`] : [])],
    summary: { status: 'saved', total: lines.length, shown: shown.length, ...(listUrl ? { list_url: listUrl } : {}) }
  };
}

function entryLine(application, entry) {
  return `- ${entry.change === 'updated' ? '更新' : '新增'} ${CATEGORY[entry.category] ?? '知识'}「${shortText(entry.content || entry.title)}」`
    + `｜${scopeLabel(entry.scope)}｜${weightLabel(entry.weight)}｜${tagLabel(entry.tags)}`
    + `｜${SOURCE[entry.content_source] ?? '来源未记录'}·${CONFIRMATION[entry.confirmation_status] ?? '待确认'}`
    + `｜[修改](<${knowledgeItemEditUrl(application, entry.item_kind, entry.item_id)}>)`;
}

// FLA working notes carry no per-item weight and are never rules to apply.
function memoryLine(application, memory, agentName) {
  const url = `${receiptConsoleUrl(application)}/agents/${encodeURIComponent(application.config.personal.spaceId)}/${encodeURIComponent(memory.agentId)}`;
  return `- ${memory.revision > 1 ? '更新' : '新增'} FLA笔记「${shortText(memory.memory.summary)}」`
    + `｜FLA ${receiptText(agentName || memory.agentId)}｜暂无权重｜无标签｜Agent笔记·不作为规则｜[查看](<${url}>)`;
}

function scopeLabel(scope) {
  const projects = scope.projects.map(project => receiptText(project.name || project.id)).join('、');
  const label = scope.kind === 'global' ? '个人全局'
    : scope.kind === 'agent' ? `FLA ${receiptText(scope.agent_name || scope.agent_id)}（${projects}）`
      : scope.kind === 'temporary' ? '临时会话项目'
        : scope.kind === 'projects' ? `项目 ${projects}` : '范围未知';
  return scope.status === 'undetermined' ? `${label}·范围待确定` : label;
}

// The weight is FULI's display weight and its basis, never a model's confidence.
function weightLabel(weight) {
  if (!weight) return '暂无权重';
  const basis = weight.basis;
  return basis.confirmed_by_person ? `权重${weight.percent}%（你已确认）`
    : `权重${weight.percent}%（用${basis.qualified_use_count}次·${basis.source_count}个来源）`;
}

function tagLabel(tags) {
  return tags?.length ? tags.map(tag => `#${receiptText(tag.name)}`).join(' ') : '无标签';
}

function shortText(value) {
  const characters = [...String(value ?? '').replace(/\s+/g, ' ').trim()];
  return receiptText(characters.length > CONTENT_CHARS ? `${characters.slice(0, CONTENT_CHARS).join('')}…` : characters.join(''));
}
