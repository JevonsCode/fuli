import { syncSearchableSelects } from './searchable-select.js';

const VALID_SCOPES = new Set(['personal', 'project']);
const VALID_ITEM_KINDS = new Set(['entity', 'relationship']);

export function createKnowledgeDeepLinkController({
  ui,
  getSpaces,
  browser,
  workspace,
  showKnowledgeView,
  onError
}) {
  const openCurrent = () => open(globalThis.location?.hash ?? '');

  return {
    listen() {
      globalThis.addEventListener?.('hashchange', openCurrent);
    },
    open
  };

  async function open(rawHash) {
    const target = parseKnowledgeDeepLink(rawHash);
    if (!target) return false;
    const spaceKey = findDeepLinkSpaceKey(getSpaces(), target);
    if (!spaceKey) {
      onError(new Error('Fuli 来源链接对应的知识空间不可用'));
      return false;
    }
    ui.graphSpace.value = spaceKey;
    syncSearchableSelects(ui.graphSpace);
    ui.graphSearch.value = '';
    browser.setMode('directory');
    showKnowledgeView();
    workspace.configureContextPicker();
    await workspace.load();
    if (!browser.openItem(target)) {
      onError(new Error('Fuli 来源记录不存在或当前无权查看'));
      return false;
    }
    return true;
  }
}

export function parseKnowledgeDeepLink(rawHash) {
  const value = String(rawHash ?? '').replace(/^#\/?/, '');
  const parts = value.split('/');
  if (parts.length !== 5 || parts[0] !== 'knowledge') return null;
  try {
    const [, scope, rawSpaceId, itemKind, rawItemId] = parts;
    const spaceId = boundedSegment(rawSpaceId);
    const itemId = boundedSegment(rawItemId);
    if (!VALID_SCOPES.has(scope) || !VALID_ITEM_KINDS.has(itemKind)) return null;
    if (!spaceId || !itemId) return null;
    return { scope, spaceId, itemKind, itemId };
  } catch {
    return null;
  }
}

export function findDeepLinkSpaceKey(spaces, { scope, spaceId }) {
  const entries = [...(spaces?.entries?.() ?? [])];
  const matches = entries.filter(([, space]) => (
    space.id === spaceId &&
    (scope === 'personal' ? !space.providerUrl && !space.personalProjectId : space.providerUrl)
  ));
  return matches.length === 1 ? matches[0][0] : null;
}

function boundedSegment(value) {
  const decoded = decodeURIComponent(value);
  return decoded && decoded.length <= 256 ? decoded : null;
}
