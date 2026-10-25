import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';

import { canonicalJson, contentHash } from '../../packages/roundtable/src/canonical-json.js';
import { ApplicationError } from '../app/application-error.js';
import { readJsonFile } from '../storage/json-file.js';
import { jsonFormat, updateVersionedJsonFileAtomic } from '../storage/json-format.js';
import { projectOff } from './capture-project-mode.js';

// An Agent never completes a long-term capture change (rec#5 C4-2, rec#11
// D-16). Anything an Agent relays (a token, a "yes", a turn) is unverifiable,
// so the only accepted confirmation is the person's own action in the FULI
// console. An Agent's request is stored as a preview: the exact sentence FULI
// wrote, the change asked for, the settings version it was worded against and
// the client and session that asked. The Agent gets the sentence and a link to
// the console page that shows it; the console's confirm applies it once, by
// compare-and-set under the settings' format lock, and only while the settings
// are still those the sentence described. Cancel, expiry or a stale preview
// write nothing. The person's own console switches save directly; pausing one
// session never needs this.
export const CAPTURE_CHANGE_PREVIEW_FORMAT = jsonFormat({ store: 'capture-change-previews', versions: [1] });
const PREVIEW_TTL_MS = 30 * 60 * 1000;
const MAX_PENDING_PREVIEWS = 20;
const ID_BYTES = 18;
const MAX_SNAPSHOT_ATTEMPTS = 5;
const COMPARED_SETTINGS = Object.freeze(['enabled', 'disabledSources', 'projectMode', 'excludedProjectIds',
  'selectedProjectIds', 'unregisteredDirectories']);
const CLIENT_LABELS = Object.freeze({ codex: 'Codex', claude: 'Claude', claude_code: 'Claude Code', cursor: 'Cursor',
  kiro: 'Kiro', opencode: 'OpenCode', other: '其他客户端' });
const CONSOLE_GUIDANCE = 'Nothing changed. Show preview and confirmUrl to the user word for word; they confirm or cancel in the FULI console. You cannot complete this change.';
const NO_CONSOLE_GUIDANCE = 'Nothing changed. Show preview to the user word for word; they can make this change in the FULI console settings. You cannot complete this change.';
// What the console says for a preview it can no longer apply: unknown, used,
// expired, or worded against settings that have changed since.
const RESTART = '设置已变化，请重新发起';

// store: the capture settings (preview, update, version, read, path).
// listProjects: async () => the person's projects, so a preview names them as
// they do. taskContext: async (token, sourceApplication) => the task a host
// began, to show which session asked. consoleUrl: the local console, or null.
export function createCaptureChanges(store, { listProjects, taskContext, consoleUrl, now = Date.now }) {
  const previews = new CaptureChangePreviews(store.path ? join(dirname(store.path), 'capture-change-previews.json') : null, now);
  const ports = { store, previews, taskContext, consoleUrl, projectNames: () => projectNames(listProjects) };
  return Object.freeze({
    propose: (input, caller) => proposeCaptureChange(ports, input, caller),
    read: previewId => readCaptureChange(ports, previewId),
    confirm: previewId => confirmCaptureChange(ports, previewId),
    cancel: previewId => ({ status: previews.take(previewId) ? 'cancelled' : 'gone' })
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

// Pending previews, kept beside the settings so a preview an Agent's process
// made is found by the console's. Only a hash of each preview's ID is stored.
// Every change is a read-modify-write under the format lock, so a preview is
// applied or cancelled once.
class CaptureChangePreviews {
  constructor(path, now) {
    this.path = path;
    this.now = now;
    this.memory = [];
  }

  issue(preview) {
    const id = randomBytes(ID_BYTES).toString('base64url');
    const issued = { ...preview, idHash: contentHash(id), expiresAt: this.now() + PREVIEW_TTL_MS };
    this.#change(pending => [...pending, issued].slice(-MAX_PENDING_PREVIEWS));
    return { id, expiresAt: new Date(issued.expiresAt).toISOString() };
  }

  find(id) {
    const idHash = contentHash(String(id));
    return this.#pending(this.path ? readPreviews(this.path)?.previews : this.memory)
      .find(preview => preview.idHash === idHash) ?? null;
  }

  // The preview, for the one call that removes it; null for every other.
  take(id) {
    const idHash = contentHash(String(id));
    let taken = null;
    this.#change(pending => pending.filter(preview => {
      if (preview.idHash !== idHash) return true;
      taken = preview;
      return false;
    }));
    return taken;
  }

  #change(change) {
    if (!this.path) {
      this.memory = change(this.#pending(this.memory));
      return;
    }
    updateVersionedJsonFileAtomic(this.path, CAPTURE_CHANGE_PREVIEW_FORMAT,
      current => ({ version: 1, previews: change(this.#pending(current?.previews)) }), { read: readPreviews });
  }

  #pending(previews) {
    return Array.isArray(previews) ? previews.filter(preview => preview?.expiresAt > this.now()) : [];
  }
}

// An unreadable file holds no preview anyone can confirm.
function readPreviews(path) {
  try {
    return readJsonFile(path, null);
  } catch {
    return null;
  }
}

// Which session asked, for the console page only; it authorizes nothing.
async function askingSession(taskContext, { taskContextToken, sourceApplication }) {
  if (typeof taskContextToken !== 'string' || !taskContextToken) return null;
  try {
    return (await taskContext(taskContextToken, sourceApplication)).sessionId ?? null;
  } catch {
    return null;
  }
}

async function proposeCaptureChange({ store, previews, taskContext, consoleUrl, projectNames }, input, caller) {
  const { current, next, settingsVersion } = settingsSnapshot(store, input);
  if (sameSettings(current, next)) {
    return { status: 'unchanged', guidance: 'These settings are already in place; tell the user nothing needs to change.' };
  }
  const preview = describeCaptureChange(current, next, await projectNames());
  const { id, expiresAt } = previews.issue({ request: input, result: intentOf(next), preview, settingsVersion,
    sourceApplication: caller.sourceApplication, sessionId: await askingSession(taskContext, caller),
    createdAt: new Date().toISOString() });
  return { status: 'confirmation_required', preview, expiresAt,
    ...(consoleUrl ? { confirmUrl: `${consoleUrl}/capture-change/${id}`, guidance: CONSOLE_GUIDANCE }
      : { guidance: NO_CONSOLE_GUIDANCE }) };
}

// The settings, the change's result and their version, all from one moment:
// a save landing in between would let the sentence describe one state and
// the version name another (dot review, PR 262), so the reading is taken again.
function settingsSnapshot(store, input) {
  for (let attempt = 1; ; attempt += 1) {
    const settingsVersion = store.version();
    const { current, next } = store.preview(input);
    if (store.version() === settingsVersion) return { current, next, settingsVersion };
    if (attempt >= MAX_SNAPSHOT_ATTEMPTS) throw stale();
  }
}

// The console page's view of one preview: its sentence, the change setting by
// setting, the settings now, and whether it can still be applied.
function readCaptureChange({ store, previews }, previewId) {
  const preview = previews.find(previewId);
  if (!preview) throw gone();
  const { current, next } = store.preview(preview.request);
  return { status: preview.settingsVersion === store.version() ? 'pending' : 'stale', preview: preview.preview,
    sourceApplication: preview.sourceApplication, sessionId: preview.sessionId, createdAt: preview.createdAt,
    expiresAt: new Date(preview.expiresAt).toISOString(), current: store.read(),
    changes: COMPARED_SETTINGS.filter(key => canonicalJson(current[key]) !== canonicalJson(next[key]))
      .map(key => ({ setting: key, before: current[key], after: next[key] })) };
}

function confirmCaptureChange({ store, previews }, previewId) {
  const preview = previews.take(previewId);
  if (!preview) throw gone();
  if (preview.settingsVersion !== store.version()) throw stale();
  try {
    // The settings are those the sentence was written from, and the change still comes out as it said.
    return store.update(preview.request, { ifVersion: preview.settingsVersion,
      accept: next => intentOf(next) === preview.result });
  } catch (error) {
    if (error?.code === 'capture_settings_changed') throw stale();
    throw error;
  }
}

function gone() {
  return new ApplicationError('preview_expired', RESTART, { status: 410 });
}

function stale() {
  return new ApplicationError('preview_stale', RESTART, { status: 409 });
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
