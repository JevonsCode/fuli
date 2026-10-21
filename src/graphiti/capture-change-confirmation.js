import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';

import { canonicalJson, contentHash } from '../../packages/roundtable/src/canonical-json.js';
import { ApplicationError } from '../app/application-error.js';
import { readJsonFile } from '../storage/json-file.js';
import { jsonFormat, updateVersionedJsonFileAtomic } from '../storage/json-format.js';
import { projectOff } from './capture-project-mode.js';

// An Agent changes long-term capture settings only after the person confirmed
// the exact change (rec#5 C4-2). The first call previews: FULI words the change
// for the person and issues a one-time token; nothing is saved. Only a second
// call with that token and the same settings saves it, and only:
// - from a later task context of the same host session, so at least one
//   message of the person's lies between the preview and the save; FULI never
//   reads that message, the turn boundary is the evidence;
// - while the settings are still the ones the preview described, checked
//   under the lock the save takes, so a console save in between wins.
// A person who declines ("不用了") is simply not asked again: the token
// expires and nothing changes. The person's own console saves directly;
// pausing one session never needs this.
export const CAPTURE_CHANGE_PREVIEW_FORMAT = jsonFormat({ store: 'capture-change-previews', versions: [1] });
const PREVIEW_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_PREVIEWS = 20;
const TOKEN_BYTES = 18;
const COMPARED_SETTINGS = Object.freeze(['enabled', 'disabledSources', 'projectMode', 'excludedProjectIds',
  'selectedProjectIds', 'unregisteredDirectories']);
const CLIENT_LABELS = Object.freeze({ codex: 'Codex', claude: 'Claude', claude_code: 'Claude Code', cursor: 'Cursor',
  kiro: 'Kiro', other: '其他客户端' });
const CONFIRM_GUIDANCE = 'Nothing changed yet. Show preview to the user word for word and end your turn. Only after their next message confirms it, call update_capture_policy with the same settings, this previewToken and that turn\'s taskContextToken. If they decline or say anything else, do not call it; nothing changes.';
const PREVIEW_AGAIN = 'Preview the change again and ask the user again.';

// store: the capture settings (preview, update, version, path). listProjects:
// async () => the person's projects, so a preview names them as they do.
// taskContext: async (token, sourceApplication) => the task context a host
// hook began for one turn of one session.
export function createCaptureChanges(store, { listProjects, taskContext, now = Date.now }) {
  const previews = new CaptureChangePreviews(store.path ? join(dirname(store.path), 'capture-change-previews.json') : null, now);
  const ports = { store, previews, taskContext, projectNames: () => projectNames(listProjects) };
  return Object.freeze({
    propose: (input, caller) => proposeCaptureChange(ports, input, caller),
    confirm: (input, previewToken, caller) => confirmCaptureChange(ports, input, previewToken, caller)
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
// process can be confirmed through another. Only hashes of the preview token
// and of the task token it was made under are stored. Every change is a
// read-modify-write under the format lock, so a token is spent once.
class CaptureChangePreviews {
  constructor(path, now) {
    this.path = path;
    this.now = now;
    this.memory = [];
  }

  issue(preview) {
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const issued = { ...preview, tokenHash: contentHash(token), expiresAt: this.now() + PREVIEW_TTL_MS };
    this.#change(pending => [...pending, issued].slice(-MAX_PENDING_PREVIEWS));
    return { token, expiresAt: new Date(issued.expiresAt).toISOString() };
  }

  find(token) {
    const tokenHash = contentHash(token);
    return this.#pending(this.path ? readPreviews(this.path)?.previews : this.memory)
      .find(preview => preview.tokenHash === tokenHash) ?? null;
  }

  // True only for the one call that spends the token.
  take(token) {
    const tokenHash = contentHash(token);
    let taken = false;
    this.#change(pending => pending.filter(preview => {
      if (preview.tokenHash !== tokenHash) return true;
      taken = true;
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

// The turn a call is made in: the host session's task context its token names.
async function callerTurn(taskContext, { taskContextToken, sourceApplication }) {
  if (typeof taskContextToken !== 'string' || !taskContextToken) {
    throw new ApplicationError('task_context_required', 'Pass the current taskContextToken: a long-term capture change '
      + 'is confirmed in the person\'s next message of the same session. Without a task, the person changes it in '
      + 'the console settings.');
  }
  const task = await taskContext(taskContextToken, sourceApplication);
  return { sessionId: task.sessionId, taskHash: contentHash(task.token), turnId: task.turnId ?? null };
}

async function proposeCaptureChange({ store, previews, taskContext, projectNames }, input, caller) {
  const turn = await callerTurn(taskContext, caller);
  const { current, next } = store.preview(input);
  if (sameSettings(current, next)) {
    return { status: 'unchanged', guidance: 'These settings are already in place; tell the user nothing needs to change.' };
  }
  const { token, expiresAt } = previews.issue({ request: requestOf(input), settingsVersion: store.version(),
    sourceApplication: caller.sourceApplication, ...turn });
  return { status: 'confirmation_required', preview: describeCaptureChange(current, next, await projectNames()),
    previewToken: token, expiresAt, guidance: CONFIRM_GUIDANCE };
}

async function confirmCaptureChange({ store, previews, taskContext }, input, previewToken, caller) {
  const turn = await callerTurn(taskContext, caller);
  const preview = previews.find(previewToken);
  const expired = () => new ApplicationError('preview_expired',
    `This capture change preview is unknown, used or expired. ${PREVIEW_AGAIN}`);
  // Another client's or another session's preview is not this caller's to spend.
  if (!preview || preview.sourceApplication !== caller.sourceApplication || preview.sessionId !== turn.sessionId) {
    throw expired();
  }
  // Still the turn that showed the preview: the person has not answered yet, so the token stays valid.
  if (preview.taskHash === turn.taskHash || (preview.turnId !== null && preview.turnId === turn.turnId)) {
    throw new ApplicationError('preview_unconfirmed', 'The person has not answered the preview yet. End your turn '
      + 'with the preview; confirm only after their next message, with that turn\'s taskContextToken.');
  }
  if (!previews.take(previewToken)) throw expired();
  if (preview.request !== requestOf(input)) {
    throw new ApplicationError('preview_mismatch', `These settings differ from the change the user confirmed. ${PREVIEW_AGAIN}`);
  }
  // The preview described a change to the settings as they were then.
  const stale = () => new ApplicationError('preview_stale', `The capture settings changed after the preview. ${PREVIEW_AGAIN}`);
  if (preview.settingsVersion !== store.version()) throw stale();
  try {
    return store.update(input, { ifVersion: preview.settingsVersion });
  } catch (error) {
    if (error?.code === 'capture_settings_changed') throw stale();
    throw error;
  }
}

// The change asked for, in one form whatever the order of its keys and lists.
function requestOf(input) {
  return canonicalJson(Object.fromEntries(Object.entries(input).map(([key, value]) =>
    [key, Array.isArray(value) ? [...value].sort() : value])), { omitUndefined: true });
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
