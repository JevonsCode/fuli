export function createProjectManagementDialog({ ui, onDelete, onError }) {
  let project = null;
  let busy = false;

  ui.projectDeleteStart.addEventListener('click', startDelete);
  ui.projectDeleteCancel.addEventListener('click', cancelDelete);
  ui.projectDeleteName.addEventListener('input', validateName);
  ui.projectDeleteConfirm.addEventListener('click', confirmDelete);
  ui.projectManagementDialog.addEventListener('close', reset);

  return { open };

  function open(nextProject) {
    if (!nextProject.can_manage) throw new Error('只有 Owner 或公共空间管理员可以管理项目');
    project = nextProject;
    ui.projectManagementName.textContent = project.name;
    ui.projectManagementVersion.textContent = project.current_release?.version ?? '未记录';
    ui.projectManagementRole.textContent = project.isOwner
      ? 'Owner'
      : project.role === 'maintainer' ? 'Maintainer / 空间管理员' : '空间管理员';
    resetDeleteConfirmation();
    ui.projectManagementDialog.showModal();
  }

  function startDelete() {
    ui.projectDeleteStart.hidden = true;
    ui.projectDeleteConfirmation.hidden = false;
    ui.projectDeleteName.focus();
  }

  function cancelDelete() {
    if (busy) return;
    resetDeleteConfirmation();
  }

  function validateName() {
    ui.projectDeleteConfirm.disabled = !project || ui.projectDeleteName.value !== project.name;
    ui.projectDeleteError.hidden = true;
  }

  async function confirmDelete() {
    if (!project || ui.projectDeleteName.value !== project.name || busy) return;
    const deletedProject = project;
    setBusy(true);
    try {
      await onDelete(deletedProject);
      ui.projectManagementDialog.close();
    } catch (error) {
      ui.projectDeleteError.textContent = error instanceof Error ? error.message : '删除失败';
      ui.projectDeleteError.hidden = false;
      onError(error);
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    project = null;
    resetDeleteConfirmation();
  }

  function resetDeleteConfirmation() {
    ui.projectDeleteStart.hidden = false;
    ui.projectDeleteConfirmation.hidden = true;
    ui.projectDeleteName.value = '';
    ui.projectDeleteError.hidden = true;
    ui.projectDeleteError.textContent = '';
    ui.projectDeleteConfirm.disabled = true;
  }

  function setBusy(isBusy) {
    busy = isBusy;
    ui.projectManagementDialog.toggleAttribute('aria-busy', isBusy);
    ui.projectDeleteConfirm.disabled = isBusy;
    ui.projectDeleteCancel.disabled = isBusy;
    ui.projectDeleteConfirm.textContent = isBusy ? '正在删除…' : '确认永久删除';
  }
}
