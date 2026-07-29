import { compactIdentity, identitySearchText } from './identity.js';
import { syncSearchableSelects } from './searchable-select.js';

export function createKnowledgeEditorDialog({
  ui,
  revise,
  reassign,
  setPreferenceScope,
  onSuccess,
  onError
}) {
  let item = null;
  let context = null;

  ui.knowledgeEditClose.addEventListener('click', close);
  ui.knowledgeEditDialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });
  ui.knowledgeContentForm.addEventListener('submit', saveCorrection);
  ui.knowledgeAssignmentForm.addEventListener('submit', saveAssignment);
  ui.knowledgePreferenceScopeForm.addEventListener('submit', savePreferenceScope);
  ui.knowledgePreferenceScope.addEventListener('change', configurePreferenceProjectField);
  ui.knowledgeInvalidate.addEventListener('click', () => changeStatus('invalidate'));
  ui.knowledgeRestore.addEventListener('click', () => changeStatus('restore'));

  return { open, close };

  function open(nextItem, nextContext) {
    item = nextItem;
    context = nextContext;
    const raw = item.raw;
    const relationship = item.itemKind === 'relationship';
    ui.knowledgeEditTitle.textContent = item.invalidAt ? '查看和恢复知识' : '纠正知识';
    ui.knowledgeEditDescription.textContent =
      '修改会新增一条修订历史；原始会话、来源和证据不会被删除。';
    ui.knowledgeNameField.hidden = relationship;
    ui.knowledgeSummaryField.hidden = relationship;
    ui.knowledgeFactField.hidden = !relationship;
    ui.knowledgeEditName.value = relationship ? '' : raw.name;
    ui.knowledgeEditSummary.value = relationship ? '' : (raw.summary ?? '');
    ui.knowledgeEditFact.value = relationship ? (raw.fact ?? '') : '';
    ui.knowledgeEditQuadrant.value = raw.current_quadrant ?? 'known_known';
    ui.knowledgeEditEpistemicStatus.value = raw.epistemic_status ?? 'confirmed';
    ui.knowledgeEditProfileAspect.value = raw.profile_aspect ?? 'none';
    ui.knowledgeEditReasoning.value = raw.reasoning_summary ?? '';
    ui.knowledgeEditReason.value = '';
    ui.knowledgeAssignmentReason.value = '';
    ui.knowledgePreferenceScopeReason.value = '';
    ui.knowledgeInvalidate.hidden = Boolean(item.invalidAt);
    ui.knowledgeRestore.hidden = !item.invalidAt;
    ui.knowledgeAssignmentSection.hidden = Boolean(raw.profile_aspect);
    ui.knowledgePreferenceScopeSection.hidden = !raw.profile_aspect;
    configureProfileAspect();
    configureProjects();
    configurePreferenceScope();
    syncSearchableSelects(
      ui.knowledgeEditQuadrant,
      ui.knowledgeEditEpistemicStatus,
      ui.knowledgeEditProfileAspect,
      ui.knowledgeTargetProject,
      ui.knowledgePreferenceScope,
      ui.knowledgePreferenceProject
    );
    hideError(ui.knowledgeContentError);
    hideError(ui.knowledgeAssignmentError);
    hideError(ui.knowledgePreferenceScopeError);
    ui.knowledgeEditDialog.showModal();
  }

  function close() {
    if (ui.knowledgeEditDialog.open) ui.knowledgeEditDialog.close();
    item = null;
    context = null;
  }

  async function saveCorrection(event) {
    event.preventDefault();
    const reason = ui.knowledgeEditReason.value.trim();
    if (!reason) return showLocalError(ui.knowledgeContentError, '请说明纠正原因');
    const raw = item.raw;
    const relationship = item.itemKind === 'relationship';
    const payload = baseRevision('update', reason);
    const profileAspect = ui.knowledgeEditProfileAspect.value;
    if (profileAspect !== 'none' && ui.knowledgeEditEpistemicStatus.value === 'exploratory') {
      return showLocalError(
        ui.knowledgeContentError,
        '协作偏好只能是已确认或观察中的稳定信息'
      );
    }
    payload.currentQuadrant = ui.knowledgeEditQuadrant.value;
    payload.epistemicStatus = ui.knowledgeEditEpistemicStatus.value;
    payload.profileAspect = profileAspect;
    payload.reasoningSummary = ui.knowledgeEditReasoning.value.trim();
    if (relationship) {
      payload.fact = ui.knowledgeEditFact.value.trim();
      if (!payload.fact) return showLocalError(ui.knowledgeContentError, '关系事实不能为空');
      if (payload.fact === raw.fact && !taxonomyChanged(raw, payload)) {
        return showLocalError(ui.knowledgeContentError, '内容没有变化');
      }
    } else {
      payload.name = ui.knowledgeEditName.value.trim();
      payload.summary = ui.knowledgeEditSummary.value.trim();
      if (!payload.name) return showLocalError(ui.knowledgeContentError, '名称不能为空');
      if (
        payload.name === raw.name &&
        payload.summary === (raw.summary ?? '') &&
        !taxonomyChanged(raw, payload)
      ) {
        return showLocalError(ui.knowledgeContentError, '内容没有变化');
      }
    }
    await execute(ui.knowledgeSave, ui.knowledgeContentError, () => revise(payload));
  }

  async function changeStatus(action) {
    const reason = ui.knowledgeEditReason.value.trim();
    if (!reason) return showLocalError(
      ui.knowledgeContentError,
      action === 'invalidate' ? '请说明为什么这条知识已经失效' : '请说明为什么恢复有效'
    );
    const button = action === 'invalidate' ? ui.knowledgeInvalidate : ui.knowledgeRestore;
    await execute(button, ui.knowledgeContentError, () =>
      revise(baseRevision(action, reason))
    );
  }

  async function saveAssignment(event) {
    event.preventDefault();
    const targetProjectId = ui.knowledgeTargetProject.value;
    const reason = ui.knowledgeAssignmentReason.value.trim();
    if (!targetProjectId) {
      return showLocalError(ui.knowledgeAssignmentError, '请选择目标个人项目');
    }
    if (!reason) return showLocalError(ui.knowledgeAssignmentError, '请说明调整原因');
    const currentProjectId = currentProject();
    if (targetProjectId === currentProjectId) {
      return showLocalError(ui.knowledgeAssignmentError, '这条知识已经属于该项目');
    }
    await execute(ui.knowledgeReassign, ui.knowledgeAssignmentError, () => reassign({
      personalSpaceId: context.personalSpaceId,
      itemKind: item.itemKind,
      itemId: item.id,
      targetProjectId,
      reason
    }));
  }

  async function savePreferenceScope(event) {
    event.preventDefault();
    const scope = ui.knowledgePreferenceScope.value;
    const projectId = scope === 'project' ? ui.knowledgePreferenceProject.value : null;
    const reason = ui.knowledgePreferenceScopeReason.value.trim();
    if (scope === 'project' && !projectId) {
      return showLocalError(ui.knowledgePreferenceScopeError, '请选择生效的个人项目');
    }
    if (!reason) {
      return showLocalError(ui.knowledgePreferenceScopeError, '请说明为什么调整生效范围');
    }
    const raw = item.raw;
    const currentScope = raw.preference_scope ?? 'global';
    const currentProjectId = raw.preference_project_id ?? null;
    if (scope === currentScope && projectId === currentProjectId) {
      return showLocalError(ui.knowledgePreferenceScopeError, '生效范围没有变化');
    }
    await execute(
      ui.knowledgePreferenceScopeSave,
      ui.knowledgePreferenceScopeError,
      () => setPreferenceScope({
        personalSpaceId: context.personalSpaceId,
        itemKind: item.itemKind,
        itemId: item.id,
        scope,
        projectId,
        reason
      })
    );
  }

  function baseRevision(action, reason) {
    return {
      personalSpaceId: context.personalSpaceId,
      personalProjectId: context.personalProjectId ?? null,
      itemKind: item.itemKind,
      itemId: item.id,
      action,
      reason
    };
  }

  function configureProjects() {
    const options = context.projects.map((project) => {
      const option = document.createElement('option');
      option.value = project.project_id;
      option.textContent = project.profile.name;
      option.dataset.meta = `#${compactIdentity(project.project_id, 26)}`;
      option.dataset.search = identitySearchText(project.project_id);
      return option;
    });
    ui.knowledgeTargetProject.replaceChildren(...options);
    ui.knowledgePreferenceProject.replaceChildren(...options.map(({ value, textContent }) => {
      const scopeOption = document.createElement('option');
      scopeOption.value = value;
      scopeOption.textContent = textContent;
      scopeOption.dataset.meta = `#${compactIdentity(value, 26)}`;
      scopeOption.dataset.search = identitySearchText(value);
      return scopeOption;
    }));
    const current = currentProject();
    if (current && options.some(({ value }) => value === current)) {
      ui.knowledgeTargetProject.value = current;
    }
    const movable = options.length > 1 || (options.length === 1 && options[0].value !== current);
    ui.knowledgeTargetProject.disabled = !movable;
    ui.knowledgeReassign.disabled = !movable;
  }

  function configureProfileAspect() {
    for (const option of ui.knowledgeEditProfileAspect.options) {
      option.disabled = false;
    }
  }

  function configurePreferenceScope() {
    const raw = item.raw;
    ui.knowledgePreferenceScope.value = raw.preference_scope ?? 'global';
    if (raw.preference_project_id) {
      ui.knowledgePreferenceProject.value = raw.preference_project_id;
    }
    const projectOption = ui.knowledgePreferenceScope.querySelector('option[value="project"]');
    projectOption.disabled = ui.knowledgePreferenceProject.options.length === 0;
    if (projectOption.disabled) ui.knowledgePreferenceScope.value = 'global';
    configurePreferenceProjectField();
  }

  function configurePreferenceProjectField() {
    const projectScoped = ui.knowledgePreferenceScope.value === 'project';
    ui.knowledgePreferenceProjectField.hidden = !projectScoped;
    ui.knowledgePreferenceProject.disabled = !projectScoped;
    syncSearchableSelects(ui.knowledgePreferenceScope, ui.knowledgePreferenceProject);
  }

  function currentProject() {
    return item.assignments.at(0)?.project_id ??
      item.evidence.find(({ personal_project_id: id }) => id)?.personal_project_id ??
      context.personalProjectId ?? null;
  }

  async function execute(button, errorElement, operation) {
    hideError(errorElement);
    setBusy(button, true);
    try {
      await operation();
      close();
      await onSuccess();
    } catch (error) {
      showLocalError(errorElement, normalizeError(error));
      onError?.(error);
    } finally {
      setBusy(button, false);
    }
  }
}

function taxonomyChanged(raw, payload) {
  return payload.currentQuadrant !== (raw.current_quadrant ?? 'known_known') ||
    payload.epistemicStatus !== (raw.epistemic_status ?? 'confirmed') ||
    payload.profileAspect !== (raw.profile_aspect ?? 'none') ||
    payload.reasoningSummary !== (raw.reasoning_summary ?? '');
}

function setBusy(button, busy) {
  button.disabled = busy;
  button.dataset.label ??= button.textContent;
  button.textContent = busy ? '正在保存…' : button.dataset.label;
}

function showLocalError(element, message) {
  element.textContent = message;
  element.hidden = false;
}

function hideError(element) {
  element.hidden = true;
  element.textContent = '';
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
