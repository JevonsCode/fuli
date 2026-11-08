import { identityKey } from '../text/name-identity.js';
import { singleLine } from '../text/single-line.js';
import { utf8Preview } from '../text/utf8-preview.js';
import { agentUnavailableReason } from './agent-availability.js';
import { rankCandidates } from './fla-picker.js';

// The person's FLAs as a client's slash menu (11-08): one entry per FLA and
// project it works in, and one per built-in role, named `fla-<name>` so typing
// `/fla` in the client lists them. Choosing one is the same as typing
// `#FLA <name>`: task entry resolves an entry's name to exactly that FLA
// (withMenuNames). Names stay as the person wrote them; project and role text
// follow the console language. Nothing here authorizes: task entry and the
// Provider still decide whether the chosen FLA may work.

export const FLA_MENU_PREFIX = 'fla-';
const MENU_LANGUAGES = Object.freeze(['zh-CN', 'en-US']);
// Lengths in UTF-16 code units, as agent-installer counts them (Codex
// prompt names at most 64), cut only between whole characters.
const SLUG_LIMIT = 40;
const NAME_LIMIT = 60;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/gu;
const GLOBAL_PROJECT = Object.freeze({ 'zh-CN': '全局', 'en-US': 'Global' });

// One menu name per FLA placement (a role counts once, wherever it works),
// the same for the same roster on every side: the name's slug, and when
// several share it, each with its project's slug, then a number.
function flaMenuNames(candidates) {
  const items = [...new Map(candidates.map(item => [menuKey(item), item])).values()]
    .sort((a, b) => compare(menuKey(a), menuKey(b)));
  const base = item => FLA_MENU_PREFIX + (slug(item.name) || slug(item.agentId));
  const shared = new Map();
  for (const item of items) shared.set(base(item), (shared.get(base(item)) ?? 0) + 1);
  const taken = new Set();
  const names = new Map();
  for (const item of items) {
    const wanted = trimmed(shared.get(base(item)) > 1 && !item.role && item.project
      ? `${base(item)}-${slug(item.project)}` : base(item), NAME_LIMIT);
    let name = wanted;
    for (let number = 2; taken.has(name); number += 1) name = `${wanted}-${number}`;
    taken.add(name);
    names.set(menuKey(item), name);
  }
  return names;
}

// The candidates with their menu name as one more name task entry matches
// after `#FLA` (namedAtOpening), so a client's pick names exactly one.
export function withMenuNames(candidates) {
  const names = flaMenuNames(candidates);
  return candidates.map(item => ({ ...item, aliases: [...(item.aliases ?? []), names.get(menuKey(item))] }));
}

// The entries this client shows: FLAs that can continue here and have a
// project (or work globally), ranked as the picker ranks them, then the
// built-in roles, which find their project when chosen. Each says
// "name — project — role" and expands to `#FLA <name>`, or to its menu name
// when another FLA shares the name. occupationNames: key → { 'zh-CN', 'en-US' }.
export function flaMenuEntries(candidates, { sourceApplication, language, occupationNames = new Map() }) {
  const names = flaMenuNames(candidates);
  const sharing = new Map();
  for (const item of new Map(candidates.map(item => [menuKey(item), item])).values()) {
    for (const key of new Set([item.name, ...(item.aliases ?? [])].map(identityKey))) sharing.set(key, (sharing.get(key) ?? 0) + 1);
  }
  const shown = candidates.filter(item => !agentUnavailableReason(item, sourceApplication)
    && (item.role || item.projectId !== undefined));
  const roles = [...new Map(shown.filter(item => item.role).map(item => [item.agentId, item])).values()];
  return [...rankCandidates(shown.filter(item => !item.role)), ...roles].map(item => {
    const name = names.get(menuKey(item));
    const project = item.role ? null : item.projectId === null ? GLOBAL_PROJECT[language] : item.project;
    return { name, title: item.name,
      description: singleLine([item.name, project, roleText(item, language, occupationNames)].filter(Boolean).join(' — '))
        .replace(CONTROL, ''),
      text: `#FLA ${sharing.get(identityKey(item.name)) > 1 ? name : item.name}` };
  });
}

// The console language the person chose, else this computer's.
export function menuLanguage(setting, systemLocale = Intl.DateTimeFormat().resolvedOptions().locale) {
  if (MENU_LANGUAGES.includes(setting)) return setting;
  return /^zh\b/iu.test(systemLocale ?? '') ? 'zh-CN' : 'en-US';
}

// The occupation catalog's names by key, as the console shows them.
export function occupationNameMap(catalog) {
  const items = Array.isArray(catalog) ? catalog : catalog?.items ?? catalog?.occupations ?? [];
  return new Map(items.filter(item => item?.key).map(item => [item.key,
    { 'zh-CN': item.name_zh || item.name_en, 'en-US': item.name_en || item.name_zh }]));
}

function roleText(item, language, occupationNames) {
  return occupationNames.get(item.occupationKey)?.[language] || item.occupation || '';
}

function menuKey(item) {
  return item.role ? item.agentId : `${item.agentId}\u0000${item.projectId ?? ''}`;
}

function slug(text) {
  return trimmed(identityKey(text ?? '').replace(/[^\p{L}\p{M}\p{N}]+/gu, '-').replace(/^-+/u, ''), SLUG_LIMIT);
}

function trimmed(text, limit) {
  return utf8Preview(text, limit, value => value.length, '').replace(/-+$/u, '');
}

function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
