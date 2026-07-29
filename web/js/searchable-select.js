const CONTROLLERS = new WeakMap();
let activeController = null;
let controlSequence = 0;
const DOCUMENT_EVENTS = new WeakSet();

export function enhanceSearchableSelects(root = document) {
  installDocumentEvents(root.ownerDocument ?? root);
  const selects = root.matches?.('select')
    ? [root]
    : [...root.querySelectorAll('select')];
  return selects
    .filter((select) => !select.dataset.nativeSelect)
    .map((select) => CONTROLLERS.get(select) ?? createController(select));
}

export function syncSearchableSelects(...selects) {
  for (const select of selects.flat()) CONTROLLERS.get(select)?.sync();
}

export function focusSearchableSelect(select) {
  const controller = CONTROLLERS.get(select);
  if (controller) controller.focus();
  else select?.focus();
}

function createController(select) {
  const ownerDocument = select.ownerDocument;
  const controlId = select.id || `select-${++controlSequence}`;
  const wrapper = ownerDocument.createElement('div');
  wrapper.className = 'searchable-select';
  wrapper.dataset.selectId = controlId;

  const trigger = ownerDocument.createElement('button');
  trigger.type = 'button';
  trigger.className = 'searchable-select-trigger';
  trigger.setAttribute('role', 'combobox');
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-label', select.getAttribute('aria-label') || '选择');

  const current = ownerDocument.createElement('span');
  current.className = 'searchable-select-current';
  const currentLabel = ownerDocument.createElement('span');
  currentLabel.className = 'searchable-select-current-label';
  const currentMeta = ownerDocument.createElement('small');
  currentMeta.className = 'searchable-select-current-meta';
  current.append(currentLabel, currentMeta);
  const arrow = ownerDocument.createElement('i');
  arrow.className = 'searchable-select-arrow';
  arrow.setAttribute('aria-hidden', 'true');
  trigger.append(current, arrow);

  const panel = ownerDocument.createElement('div');
  panel.className = 'searchable-select-panel';
  panel.hidden = true;

  const searchBox = ownerDocument.createElement('div');
  searchBox.className = 'searchable-select-search';
  const search = ownerDocument.createElement('input');
  search.type = 'search';
  search.autocomplete = 'off';
  search.placeholder = '搜索名称或 ID';
  search.setAttribute('aria-label', `搜索${select.getAttribute('aria-label') || '选项'}`);
  searchBox.append(search);

  const list = ownerDocument.createElement('div');
  list.className = 'searchable-select-options';
  list.id = `${controlId}-options`;
  list.setAttribute('role', 'listbox');
  trigger.setAttribute('aria-controls', list.id);

  const empty = ownerDocument.createElement('p');
  empty.className = 'searchable-select-empty';
  empty.textContent = '没有匹配项';
  empty.hidden = true;
  panel.append(searchBox, list, empty);

  select.before(wrapper);
  wrapper.append(select, trigger, panel);
  select.classList.add('searchable-select-native');
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');

  const controller = { wrapper, trigger, panel, search, list, sync, open, close, focus };
  CONTROLLERS.set(select, controller);

  trigger.addEventListener('click', () => panel.hidden ? open() : close());
  trigger.addEventListener('keydown', triggerKeydown);
  search.addEventListener('input', filterOptions);
  search.addEventListener('keydown', searchKeydown);
  select.addEventListener('change', sync);

  const Observer = ownerDocument.defaultView?.MutationObserver ?? globalThis.MutationObserver;
  if (Observer) {
    const observer = new Observer(() => queueMicrotask(sync));
    observer.observe(select, {
      attributes: true,
      attributeFilter: ['disabled', 'hidden', 'label', 'selected', 'value'],
      childList: true,
      subtree: true
    });
  }

  sync();
  return controller;

  function sync() {
    wrapper.hidden = select.hidden;
    trigger.disabled = select.disabled;
    wrapper.classList.toggle('disabled', select.disabled);
    const selected = select.selectedOptions?.[0] ??
      [...select.options].find((option) => option.selected) ?? null;
    currentLabel.textContent = selected?.textContent || select.dataset.placeholder || '请选择';
    currentMeta.textContent = selected?.dataset.meta || '';
    currentMeta.hidden = !currentMeta.textContent;
    renderOptions();
  }

  function renderOptions() {
    const options = [...select.options].filter((option) => !option.hidden);
    list.replaceChildren(...options.map(renderOption));
    const searchable = select.dataset.searchable === 'true' || options.length > 5;
    searchBox.hidden = !searchable;
    filterOptions();
  }

  function renderOption(option, index) {
    const item = ownerDocument.createElement('button');
    item.type = 'button';
    item.className = 'searchable-select-option';
    item.id = `${controlId}-option-${index}`;
    item.dataset.value = option.value;
    item.dataset.search = [
      option.textContent,
      option.value,
      option.dataset.meta,
      option.dataset.search
    ].filter(Boolean).join(' ').toLocaleLowerCase('zh-CN');
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(option.selected));
    item.disabled = option.disabled;

    const copy = ownerDocument.createElement('span');
    copy.className = 'searchable-select-option-copy';
    const label = ownerDocument.createElement('strong');
    label.textContent = option.textContent;
    const meta = ownerDocument.createElement('small');
    meta.textContent = option.dataset.meta || '';
    meta.hidden = !meta.textContent;
    copy.append(label, meta);
    const check = ownerDocument.createElement('i');
    check.className = 'searchable-select-check';
    check.setAttribute('aria-hidden', 'true');
    item.append(copy, check);
    item.addEventListener('click', () => choose(option.value));
    item.addEventListener('keydown', optionKeydown);
    return item;
  }

  function choose(value) {
    if (select.disabled) return;
    for (const option of select.options) option.selected = option.value === value;
    select.dispatchEvent(new ownerDocument.defaultView.Event('change', { bubbles: true }));
    sync();
    close({ restoreFocus: true });
  }

  function open() {
    if (select.disabled) return;
    if (activeController && activeController !== controller) activeController.close();
    activeController = controller;
    sync();
    panel.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    wrapper.classList.add('open');
    positionPanel();
    globalThis.setTimeout?.(() => {
      if (!searchBox.hidden) {
        search.value = '';
        filterOptions();
        search.focus();
      } else {
        selectedOrFirstOption()?.focus();
      }
    }, 0);
  }

  function close({ restoreFocus = false } = {}) {
    panel.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    wrapper.classList.remove('open', 'open-up');
    if (activeController === controller) activeController = null;
    if (restoreFocus) trigger.focus();
  }

  function focus() {
    trigger.focus();
  }

  function filterOptions() {
    const query = search.value.trim().toLocaleLowerCase('zh-CN');
    let visible = 0;
    for (const item of list.children) {
      const matches = !query || item.dataset.search.includes(query);
      item.hidden = !matches;
      if (matches) visible += 1;
    }
    empty.hidden = visible > 0;
  }

  function triggerKeydown(event) {
    if (!['ArrowDown', 'Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    open();
  }

  function searchKeydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      close({ restoreFocus: true });
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      firstVisibleOption()?.focus();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      firstVisibleOption()?.click();
    }
  }

  function optionKeydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      close({ restoreFocus: true });
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const options = visibleOptions();
    const currentIndex = options.indexOf(event.currentTarget);
    const nextIndex = event.key === 'Home' ? 0
      : event.key === 'End' ? options.length - 1
        : event.key === 'ArrowDown'
          ? Math.min(options.length - 1, currentIndex + 1)
          : Math.max(0, currentIndex - 1);
    options[nextIndex]?.focus();
  }

  function visibleOptions() {
    return [...list.children].filter((item) => !item.hidden && !item.disabled);
  }

  function firstVisibleOption() {
    return visibleOptions()[0] ?? null;
  }

  function selectedOrFirstOption() {
    return [...list.children].find((item) =>
      !item.hidden && item.getAttribute('aria-selected') === 'true'
    ) ?? firstVisibleOption();
  }

  function positionPanel() {
    const viewportHeight = ownerDocument.defaultView?.innerHeight ?? 0;
    if (!viewportHeight || !trigger.getBoundingClientRect) return;
    const bounds = trigger.getBoundingClientRect();
    wrapper.classList.toggle('open-up', viewportHeight - bounds.bottom < 270 && bounds.top > 270);
  }
}

function installDocumentEvents(ownerDocument) {
  if (!ownerDocument?.addEventListener || DOCUMENT_EVENTS.has(ownerDocument)) return;
  DOCUMENT_EVENTS.add(ownerDocument);
  ownerDocument.addEventListener('pointerdown', (event) => {
    if (activeController && !activeController.wrapper.contains(event.target)) {
      activeController.close();
    }
  });
}
