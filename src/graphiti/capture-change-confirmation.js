import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';

import { canonicalJson, contentHash } from '../../packages/roundtable/src/canonical-json.js';
import { ApplicationError } from '../app/application-error.js';
import { readJsonFile, writeJsonFileAtomic } from '../storage/json-file.js';
import { projectOff } from './capture-project-mode.js';

// An Agent changes long-term capture settings only after the person confirmed
// the exact change (rec#5 C4-2). The first call previews: FULI words the change
// for the person and issues a one-time token; nothing is saved. Only a second
// call with that token and the same settings saves it, and only while the
// settings are still the ones the preview described. A person who declines
// ("不用了") is simply not asked again: the token expires and nothing changes.
// The person's own console saves directly; pausing one session never needs this.
const PREVIEW_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_PREVIEWS = 20;
const TOKEN_BYTES = 18;
const COMPARED_SETTINGS = Object.freeze(['enabled', 'disabledSources', 'projectMode', 'excludedProjectIds',
  'selectedProjectIds', 'unregisteredDirectories']);
const CLIENT_LABELS = Object.freeze({ codex: 'Codex', claude: 'Claude', claude_code: 'Claude Code', cursor: 'Cursor',
  kiro: 'Kiro', other: '其他客户端' });
const CONFIRM_GUIDANCE = 'Nothing changed yet. Show preview to the user word for word and wait for their answer. Only if they confirm, call update_capture_policy again with the same settings plus this previewToken. If they decline or say anything else, do not call it; nothing changes.';
const PREVIEW_AGAIN = 'Preview the change again and ask the user again.';

// store: the capture settings (preview, update, version, path); listProjects:
// async () => the person's projects, so a preview names them as they do.
export function createCaptureChanges(store, { listProjects, now = Date.now }) {
  const previews = new CaptureChangePreviews(store.path ? join(dirname(store.path), 'capture-change-previews.json') : null, now);
  const ports = { store, previews, projectNames: () => projectNames(listProjects) };
  return Object.freeze({
    propose: (input, sourceApplication) => proposeCaptureChange(ports, input, sourceApplication),
    confirm: (input, previewToken, sourceApplication) => confirmCaptureChange(ports, input, previewToken, sourceApplication)
  });
}

// Projects by the name the person knows, or by ID when the registry is unreachable.
async function projectNames(listProjects) {
  try {
    return new Map((await listProjects()).map(project => [project.project_id, project.profile?.name || project.project_id]));
  } catch {
    return new Map();
  }
}

// Pending previews, kept beside the settings so a preview made by one FULI
// process can be confirmed through another. Only token hashes are stored.
class CaptureChangePreviews {
  constructor(path, now) {
    this.path = path;
    this.now = now;
    this.memory = [];
  }

  issue(preview) {
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const pending = [...this.#pending(), { ...preview, tokenHash: contentHash(token),
      expiresAt: this.now() + PREVIEW_TTL_MS }].slice(-MAX_PENDING_PREVIEWS);
    this.#save(pending);
    return { token, expiresAt: new Date(pending.at(-1).expiresAt).toISOString() };
  }

  // A token is used once, whatever the outcome.
  take(token) {
    const tokenHash = contentHash(token);
    const pending = this.#pending();
    const found = pending.find(preview => preview.tokenHash === tokenHash) ?? null;
    if (found) this.#save(pending.filter(preview => preview !== found));
    return found;
  }

  // An unreadable file holds no preview anyone can confirm.
  #pending() {
    let stored = this.memory;
    if (this.path) {
      try {
        stored = readJsonFile(this.path, { previews: [] }).previews;
      } catch {
        stored = [];
      }
    }
    return Array.isArray(stored) ? stored.filter(preview => preview?.expiresAt > this.now()) : [];
  }

  #save(previews) {
    if (this.path) writeJsonFileAtomic(this.path, { version: 1, previews });
    else this.memory = previews;
  }
}

async function proposeCaptureChange({ store, previews, projectNames }, input, sourceApplication) {
  const { current, next } = store.preview(input);
  if (sameSettings(current, next)) {
    return { status: 'unchanged', guidance: 'These settings are already in place; tell the user nothing needs to change.' };
  }
  const { token, expiresAt } = previews.issue({ intent: intentOf(next), settingsVersion: store.version(),
    sourceApplication });
  return { status: 'confirmation_required', preview: describeCaptureChange(current, next, await projectNames()),
    previewToken: token, expiresAt, guidance: CONFIRM_GUIDANCE };
}

function confirmCaptureChange({ store, previews }, input, previewToken, sourceApplication) {
  const preview = previews.take(previewToken);
  if (!preview || preview.sourceApplication !== sourceApplication) {
    throw new ApplicationError('preview_expired', `This capture change preview is unknown, used or expired. ${PREVIEW_AGAIN}`);
  }
  if (preview.settingsVersion !== store.version()) {
    throw new ApplicationError('preview_stale', `The capture settings changed after the preview. ${PREVIEW_AGAIN}`);
  }
  if (preview.intent !== intentOf(store.preview(input).next)) {
    throw new ApplicationError('preview_mismatch', `These settings differ from the change the user confirmed. ${PREVIEW_AGAIN}`);
  }
  return store.update(input);
}

function intentOf(settings) {
  return canonicalJson(Object.fromEntries(COMPARED_SETTINGS.map(key => [key, settings[key]])));
}

function sameSettings(current, next) {
  return intentOf(current) === intentOf(next);
}

// The change in the person's words: what stops or starts being recorded, by
// name, and that nothing recorded so far is removed.
function describeCaptureChange(current, next, names) {
  const name = id => `『${names.get(id) ?? id}』`;
  const changes = [];
  if (current.enabled !== next.enabled) {
    changes.push(next.enabled ? '打开自动记录' : '关闭自动记录，所有客户端和项目都不再记录');
  }
  const clients = (from, to) => to.filter(source => !from.includes(source)).map(source => CLIENT_LABELS[source]);
  const stoppedClients = clients(current.disabledSources, next.disabledSources);
  const resumedClients = clients(next.disabledSources, current.disabledSources);
  if (stoppedClients.length) changes.push(`不再记录 ${stoppedClients.join('、')} 的会话`);
  if (resumedClients.length) changes.push(`恢复记录 ${resumedClients.join('、')} 的会话`);
  changes.push(...projectChanges(current, next, name));
  if (current.unregisteredDirectories !== next.unregisteredDirectories) {
    changes.push(next.unregisteredDirectories === 'skip' ? '不属于任何 FULI 项目的目录不再记录'
      : '不属于任何 FULI 项目的目录也会记录');
  }
  // A mode switch that leaves every project as it was (all to all_except with
  // nobody excluded yet) still changes what later switches mean.
  if (!changes.length) changes.push('调整项目的记录方式，目前哪些项目被记录不变');
  return `将${changes.join('；')}，已有记录保留。确认吗？`;
}

function projectChanges(current, next, name) {
  if (next.projectMode === 'selected' && current.projectMode !== 'selected') {
    return [next.selectedProjectIds.length
      ? `改为只记录${next.selectedProjectIds.map(name).join('、')}，其他项目里的会话都不会被记录`
      : '改为只记录选中的项目，但没有选中任何项目，所有项目里的会话都不会被记录'];
  }
  if (next.projectMode === 'all' && current.projectMode !== 'all') return ['改为记录全部项目'];
  if (next.projectMode === 'all_except' && current.projectMode === 'selected') {
    return [next.excludedProjectIds.length ? `改为记录全部项目，${next.excludedProjectIds.map(name).join('、')}除外`
      : '改为记录全部项目'];
  }
  const ids = [...new Set([...current.excludedProjectIds, ...current.selectedProjectIds, ...next.excludedProjectIds,
    ...next.selectedProjectIds])].sort();
  const stopped = ids.filter(id => !projectOff(current, id) && projectOff(next, id));
  const started = ids.filter(id => projectOff(current, id) && !projectOff(next, id));
  const selected = next.projectMode === 'selected';
  return [
    ...(stopped.length ? [`把${stopped.map(name).join('、')}${selected ? '移出记录列表' : '加入不记录列表'}，之后在${
      stopped.length > 1 ? '这些' : '这个'}项目里的会话都不会被记录`] : []),
    ...(started.length ? [`把${started.map(name).join('、')}${selected ? '加入记录列表' : '移出不记录列表'}，之后在${
      started.length > 1 ? '这些' : '这个'}项目里的会话会被记录`] : [])
  ];
}
