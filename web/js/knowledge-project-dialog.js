import { compactIdentity, identitySearchText } from './identity.js';
import { syncSearchableSelects } from './searchable-select.js';

export function createKnowledgeProjectDialog({
  ui,
  preview,
  apply,
  onSuccess,
  onError
}) {
  let item = null;
  let context = null;
  let sourceProjectId = null;
  let currentPreview = null;
  let previewVersion = 0;
  let idTouched = false;

  ui.knowledgeProjectClose.addEventListener('click', close);
  ui.knowledgeProjectCancel.addEventListener('click', close);
  ui.knowledgeProjectDialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });
  ui.knowledgeProjectModeCreate.addEventListener('change', renderMode);
  ui.knowledgeProjectModeExisting.addEventListener('change', renderMode);
  ui.knowledgeProjectTarget.addEventListener('change', loadPreview);
  ui.knowledgeProjectNewName.addEventListener('input', syncProjectId);
  ui.knowledgeProjectNewId.addEventListener('input', () => {
    idTouched = true;
  });
  ui.knowledgeProjectKeepRelation.addEventListener('change', configureRelationType);
  ui.knowledgeProjectForm.addEventListener('submit', submit);

  return { open, close };

  function open(nextItem, nextContext) {
    item = nextItem;
    context = nextContext;
    sourceProjectId = currentProject(item, context);
    currentPreview = null;
    previewVersion += 1;
    idTouched = false;

    const raw = item.raw;
    ui.knowledgeProjectSourceName.textContent = raw.name;
    ui.knowledgeProjectSourceSummary.textContent = raw.summary || '没有补充说明';
    ui.knowledgeProjectNewName.value = raw.name;
    ui.knowledgeProjectNewId.value = projectIdFrom(raw.name);
    ui.knowledgeProjectNewPurpose.value = raw.summary || '';
    ui.knowledgeProjectReason.value = `基于图谱节点“${raw.name}”建立项目知识范围`;
    ui.knowledgeProjectModeCreate.checked = true;
    ui.knowledgeProjectModeExisting.checked = false;
    ui.knowledgeProjectKeepRelation.checked = true;
    ui.knowledgeProjectRelationType.selectedIndex = 0;
    resetConflictResolution();
    configureProjects();
    hideError();
    renderMode();
    syncSearchableSelects(
      ui.knowledgeProjectTarget,
      ui.knowledgeProjectRelationType
    );
    ui.knowledgeProjectDialog.showModal();
  }

  function close() {
    previewVersion += 1;
    if (ui.knowledgeProjectDialog.open) ui.knowledgeProjectDialog.close();
    item = null;
    context = null;
    currentPreview = null;
  }

  function configureProjects() {
    const projects = context.projects.filter(
      ({ project_id: projectId }) => projectId !== sourceProjectId
    );
    ui.knowledgeProjectTarget.replaceChildren(...projects.map((project) => {
      const option = document.createElement('option');
      option.value = project.project_id;
      option.textContent = project.profile.name;
      option.dataset.meta = `#${compactIdentity(project.project_id, 26)}`;
      option.dataset.search = identitySearchText(project.project_id);
      return option;
    }));
    const hasTarget = projects.length > 0;
    if (hasTarget) ui.knowledgeProjectTarget.selectedIndex = 0;
    ui.knowledgeProjectModeExisting.disabled = !hasTarget;
    ui.knowledgeProjectModeExisting.closest('label').classList.toggle(
      'disabled', !hasTarget
    );
  }

  function renderMode() {
    const existing = mode() === 'existing';
    ui.knowledgeProjectNewFields.hidden = existing;
    ui.knowledgeProjectExistingFields.hidden = !existing;
    ui.knowledgeProjectNewName.required = !existing;
    ui.knowledgeProjectNewId.required = !existing;
    ui.knowledgeProjectTarget.required = existing;
    ui.knowledgeProjectRelationSection.hidden = !sourceProjectId;
    configureRelationLabels(existing);
    configureRelationType();
    hideError();
    if (existing) loadPreview();
    else renderCreatePreview();
  }

  function configureRelationLabels(existing) {
    const subject = existing ? '来源项目' : '新项目';
    const object = existing ? '目标项目' : '来源项目';
    const labels = {
      RELATED_TO: `与${object}相关`,
      PART_OF: `${subject}属于${object}`,
      DEPENDS_ON: `${subject}依赖${object}`,
      PROVIDES_TO: `${subject}向${object}提供能力`,
      SHARES_CAPABILITY_WITH: `与${object}共享能力`,
      SUCCESSOR_OF: `${subject}是${object}的后继`
    };
    for (const option of ui.knowledgeProjectRelationType.options) {
      option.textContent = labels[option.value] ?? option.textContent;
    }
  }

  function renderCreatePreview() {
    currentPreview = null;
    ui.knowledgeProjectPreviewLabel.textContent = '创建预览';
    ui.knowledgeProjectPreviewTitle.textContent = '将创建一个新的个人项目';
    ui.knowledgeProjectPreviewCopy.textContent = sourceProjectId
      ? '当前节点继续由来源项目主要维护，新项目会引用它。'
      : '当前节点会成为新项目的主要归属知识。';
    ui.knowledgeProjectCompare.hidden = true;
    ui.knowledgeProjectConflictOptions.hidden = true;
    ui.knowledgeProjectConfirm.disabled = false;
    ui.knowledgeProjectConfirm.textContent = '创建项目';
  }

  async function loadPreview() {
    const targetProjectId = selectValue(ui.knowledgeProjectTarget);
    if (mode() !== 'existing' || !targetProjectId || !item) return;
    const version = ++previewVersion;
    currentPreview = null;
    ui.knowledgeProjectPreviewLabel.textContent = '正在检查';
    ui.knowledgeProjectPreviewTitle.textContent = '正在检查重复与冲突…';
    ui.knowledgeProjectPreviewCopy.textContent = '只比较目标项目和当前节点。';
    ui.knowledgeProjectCompare.hidden = true;
    ui.knowledgeProjectConflictOptions.hidden = true;
    ui.knowledgeProjectConfirm.disabled = true;
    hideError();
    try {
      const result = await preview({
        personalSpaceId: context.personalSpaceId,
        itemKind: item.itemKind,
        itemId: item.id,
        targetProjectId
      });
      if (version !== previewVersion || !item) return;
      currentPreview = result;
      renderPreviewResult(result);
    } catch (error) {
      if (version !== previewVersion || !item) return;
      showError(normalizeError(error));
      onError?.(error);
    }
  }

  function renderPreviewResult(result) {
    const { match } = result;
    const labels = {
      none: ['可以加入', '未检测到重复或已确认的同名冲突'],
      already_linked: ['已经加入', '目标项目已经在使用这条知识'],
      exact_duplicate: ['发现重复', '将复用目标项目已有内容，不再创建副本'],
      conflict: ['发现冲突', '两条已确认知识同名，但内容不同']
    };
    const [label, title] = labels[match.kind] ?? labels.none;
    ui.knowledgeProjectPreviewLabel.textContent = label;
    ui.knowledgeProjectPreviewTitle.textContent = title;
    ui.knowledgeProjectPreviewCopy.textContent = match.reason;
    const compare = ['exact_duplicate', 'conflict'].includes(match.kind);
    ui.knowledgeProjectCompare.hidden = !compare;
    if (compare) {
      ui.knowledgeProjectCurrentName.textContent = result.item_name;
      ui.knowledgeProjectCurrentCopy.textContent = result.item_summary || '没有补充说明';
      ui.knowledgeProjectMatchName.textContent = match.item_name || '目标项目内容';
      ui.knowledgeProjectMatchCopy.textContent = match.item_summary || '没有补充说明';
    }
    ui.knowledgeProjectConflictOptions.hidden = match.kind !== 'conflict';
    if (match.kind === 'conflict') resetConflictResolution();
    ui.knowledgeProjectConfirm.disabled = false;
    ui.knowledgeProjectConfirm.textContent = match.kind === 'exact_duplicate'
      ? '复用现有内容' : '加入项目';
  }

  async function submit(event) {
    event.preventDefault();
    if (!item || !context) return;
    if (mode() === 'existing' && !currentPreview) {
      return showError('请等待重复与冲突检查完成');
    }
    const payload = {
      personalSpaceId: context.personalSpaceId,
      itemKind: item.itemKind,
      itemId: item.id,
      mode: mode(),
      targetProjectId: mode() === 'existing'
        ? selectValue(ui.knowledgeProjectTarget) : null,
      newProjectId: mode() === 'create' ? ui.knowledgeProjectNewId.value.trim() : null,
      newProjectName: mode() === 'create' ? ui.knowledgeProjectNewName.value.trim() : null,
      newProjectPurpose: mode() === 'create'
        ? ui.knowledgeProjectNewPurpose.value.trim() : null,
      keepSourceRelation: Boolean(
        sourceProjectId && ui.knowledgeProjectKeepRelation.checked
      ),
      relationType: selectValue(ui.knowledgeProjectRelationType),
      conflictResolution: selectedConflictResolution(),
      reason: ui.knowledgeProjectReason.value.trim()
    };
    if (payload.mode === 'create' && (!payload.newProjectId || !payload.newProjectName)) {
      return showError('请填写项目名称和项目标识');
    }
    if (!payload.reason) return showError('请填写操作说明');

    setBusy(true);
    hideError();
    try {
      const result = await apply(payload);
      const targetName = payload.mode === 'create'
        ? payload.newProjectName
        : selectedTargetName();
      close();
      await onSuccess(result, targetName);
    } catch (error) {
      showError(normalizeError(error));
      onError?.(error);
    } finally {
      setBusy(false);
    }
  }

  function syncProjectId() {
    if (!idTouched) {
      ui.knowledgeProjectNewId.value = projectIdFrom(ui.knowledgeProjectNewName.value);
    }
  }

  function configureRelationType() {
    ui.knowledgeProjectRelationType.disabled = !(
      sourceProjectId && ui.knowledgeProjectKeepRelation.checked
    );
    syncSearchableSelects(ui.knowledgeProjectRelationType);
  }

  function mode() {
    return ui.knowledgeProjectModeExisting.checked ? 'existing' : 'create';
  }

  function selectedConflictResolution() {
    return ui.knowledgeProjectForm.querySelector(
      'input[name="knowledge-conflict-resolution"]:checked'
    )?.value ?? 'defer';
  }

  function resetConflictResolution() {
    const option = ui.knowledgeProjectForm.querySelector(
      'input[name="knowledge-conflict-resolution"][value="defer"]'
    );
    if (option) option.checked = true;
  }

  function selectedTargetName() {
    return ui.knowledgeProjectTarget.selectedOptions?.[0]?.textContent ??
      ui.knowledgeProjectTarget.options[ui.knowledgeProjectTarget.selectedIndex]?.textContent ??
      '目标项目';
  }

  function setBusy(busy) {
    ui.knowledgeProjectConfirm.disabled = busy;
    ui.knowledgeProjectConfirm.dataset.label ??= ui.knowledgeProjectConfirm.textContent;
    ui.knowledgeProjectConfirm.textContent = busy
      ? '正在处理…'
      : (mode() === 'create' ? '创建项目' :
        currentPreview?.match.kind === 'exact_duplicate' ? '复用现有内容' : '加入项目');
  }

  function showError(message) {
    ui.knowledgeProjectError.textContent = message;
    ui.knowledgeProjectError.hidden = false;
  }

  function hideError() {
    ui.knowledgeProjectError.hidden = true;
    ui.knowledgeProjectError.textContent = '';
  }
}

function currentProject(item, context) {
  return item.assignments.at(0)?.project_id ??
    item.evidence.find(({ personal_project_id: projectId }) => projectId)
      ?.personal_project_id ??
    context.personalProjectId ?? null;
}

function projectIdFrom(value) {
  const normalized = String(value || '').normalize('NFKC').toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 128);
  return normalized || 'new-project';
}

function normalizeError(error) {
  const text = error instanceof Error ? error.message : String(error);
  try {
    const parsed = JSON.parse(text);
    return parsed.message ?? parsed.detail ?? text;
  } catch {
    return text;
  }
}

function selectValue(select) {
  return select.value ?? select.options[select.selectedIndex]?.value ?? '';
}
