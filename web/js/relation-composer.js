import { projectKey } from './project-cards.js';
import { compactIdentity, identitySearchText } from './identity.js';
import { focusSearchableSelect, syncSearchableSelects } from './searchable-select.js';

const RELATION_LABELS = Object.freeze({
  PART_OF: '属于',
  DEPENDS_ON: '依赖',
  PROVIDES_TO: '提供能力',
  SHARES_CAPABILITY_WITH: '共享能力',
  SUCCESSOR_OF: '后继于',
  RELATED_TO: '相关'
});

export function createRelationComposer({ ui, onSubmit, onError }) {
  let projects = new Map();
  let selectedTargetKey = '';
  let selectedRelationTypeValue = '';
  let busy = false;

  ui.relationAddButton.addEventListener('click', open);
  ui.relationCancelButton.addEventListener('click', close);
  ui.relationSource.addEventListener('change', sourceChanged);
  ui.relationTargetSearch.addEventListener('input', renderTargets);
  ui.projectRelationForm.addEventListener('change', relationChanged);
  ui.projectRelationForm.addEventListener('submit', submit);

  return { configure, open, close };

  function configure(nextProjects) {
    const sourceValue = ui.relationSource.value;
    projects = new Map(nextProjects.map((project) => [projectKey(project), project]));
    const sources = nextProjects.filter(({ role }) => role === 'maintainer');
    const selectedSourceKey = sources.some((project) => projectKey(project) === sourceValue)
      ? sourceValue
      : sources[0] ? projectKey(sources[0]) : '';
    ui.relationSource.replaceChildren(...sources.map((project) =>
      option(project, projectKey(project) === selectedSourceKey)
    ));
    syncSearchableSelects(ui.relationSource);

    const canCreate = sources.some((source) => nextProjects.some((target) =>
      target.id !== source.id && target.providerUrl === source.providerUrl
    ));
    ui.relationAddButton.disabled = !canCreate;
    ui.relationAddButton.title = canCreate
      ? ''
      : '至少需要两个位于同一公共 Provider 的项目，且你能维护其中一个';
    ensureValidTarget();
    renderTargets();
    updatePreview();
  }

  function open() {
    if (ui.relationAddButton.disabled) return;
    ui.relationComposer.hidden = false;
    ui.relationAddButton.setAttribute('aria-expanded', 'true');
    clearValidation();
    updatePreview();
    focusSearchableSelect(ui.relationSource);
  }

  function close() {
    if (busy) return;
    ui.relationComposer.hidden = true;
    ui.relationAddButton.setAttribute('aria-expanded', 'false');
    clearValidation();
    ui.relationAddButton.focus();
  }

  function sourceChanged() {
    ensureValidTarget();
    ui.relationTargetSearch.value = '';
    renderTargets();
    updatePreview();
  }

  function relationChanged(event) {
    if (event.target.name === 'relation-target') selectedTargetKey = event.target.value;
    if (event.target.name === 'relation-type') selectedRelationTypeValue = event.target.value;
    if (event.target.name === 'relation-target' || event.target.name === 'relation-type') {
      clearValidation();
      updatePreview();
    }
  }

  function renderTargets() {
    const source = projects.get(ui.relationSource.value);
    const query = ui.relationTargetSearch.value.trim().toLocaleLowerCase('zh-CN');
    const targets = [...projects.entries()].filter(([key, project]) =>
      key !== ui.relationSource.value &&
      project.providerUrl === source?.providerUrl &&
      (!query || `${project.name} ${project.purpose ?? project.description ?? ''}`
        .toLocaleLowerCase('zh-CN').includes(query))
    );

    if (!targets.length) {
      const empty = document.createElement('p');
      empty.className = 'relation-target-empty';
      empty.textContent = query ? '没有匹配的公共项目' : '当前没有可关联的项目';
      ui.relationTargetList.replaceChildren(empty);
      return;
    }
    ui.relationTargetList.replaceChildren(...targets.map(([key, project]) => targetOption(key, project)));
  }

  function targetOption(key, project) {
    const label = document.createElement('label');
    label.className = 'relation-target-option';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'relation-target';
    input.value = key;
    input.checked = key === selectedTargetKey;
    const copy = document.createElement('span');
    const name = document.createElement('strong');
    name.textContent = project.name;
    const purpose = document.createElement('small');
    purpose.textContent = project.purpose || project.description || '公共项目';
    copy.append(name, purpose);
    label.append(input, copy);
    return label;
  }

  function ensureValidTarget() {
    const source = projects.get(ui.relationSource.value);
    const target = projects.get(selectedTargetKey);
    if (!source || !target || source.id === target.id || source.providerUrl !== target.providerUrl) {
      selectedTargetKey = '';
    }
  }

  function updatePreview() {
    const source = projects.get(ui.relationSource.value);
    const target = projects.get(selectedTargetKey);
    const relationType = selectedRelationType();
    ui.relationPreviewSource.textContent = source?.name ?? '选择项目';
    ui.relationPreviewType.textContent = RELATION_LABELS[relationType] ?? '选择关系';
    ui.relationPreviewTarget.textContent = target?.name ?? '选择项目';

    if (relationType === 'PART_OF') {
      const parent = target ? `“${target.name}”` : '目标项目';
      ui.relationRule.textContent = `保存后等待 ${parent} Maintainer 确认，确认前不会形成正式父子关系。`;
      return;
    }
    ui.relationRule.textContent = relationType
      ? '保存后立即生效；关系不会自动订阅项目或授予权限。'
      : '选择关系后会在这里显示生效和审核规则。';
  }

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    const source = projects.get(ui.relationSource.value);
    const target = projects.get(selectedTargetKey);
    const relationType = selectedRelationType();
    const validation = validate(source, target, relationType);
    if (validation) {
      showValidation(validation);
      return;
    }

    setBusy(true);
    try {
      await onSubmit({ source, target, relationType });
      resetSelection();
      setBusy(false);
      close();
    } catch (error) {
      showValidation(error instanceof Error ? error.message : '项目关系添加失败');
      onError(error);
    } finally {
      if (busy) setBusy(false);
    }
  }

  function validate(source, target, relationType) {
    if (!source) return '请选择来源项目。';
    if (!relationType) return '请选择一种项目关系。';
    if (!target) return '请选择要关联的目标项目。';
    if (source.id === target.id) return '来源项目和目标项目不能相同。';
    if (source.providerUrl !== target.providerUrl) return '当前仅支持同一公共 Provider 内建立项目关系。';
    return '';
  }

  function resetSelection() {
    selectedTargetKey = '';
    selectedRelationTypeValue = '';
    ui.relationTargetSearch.value = '';
    for (const input of ui.projectRelationForm.querySelectorAll('[name="relation-type"]')) {
      input.checked = false;
    }
    renderTargets();
    updatePreview();
  }

  function selectedRelationType() {
    return selectedRelationTypeValue;
  }

  function showValidation(message) {
    ui.relationValidation.textContent = message;
    ui.relationValidation.hidden = false;
  }

  function clearValidation() {
    ui.relationValidation.hidden = true;
    ui.relationValidation.textContent = '';
  }

  function setBusy(isBusy) {
    busy = isBusy;
    ui.projectRelationForm.toggleAttribute('aria-busy', isBusy);
    ui.relationSubmitButton.disabled = isBusy;
    ui.relationCancelButton.disabled = isBusy;
    ui.relationSubmitButton.textContent = isBusy ? '正在添加…' : '添加这条关系';
  }
}

function option(project, selected) {
  const item = document.createElement('option');
  item.value = projectKey(project);
  item.textContent = project.name;
  item.dataset.meta = `#${compactIdentity(project.id, 26)}`;
  item.dataset.search = identitySearchText(project.id);
  if (selected) item.setAttribute('selected', '');
  return item;
}
