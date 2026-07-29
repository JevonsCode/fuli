export function createPublicationDialog({
  dialog,
  projectName,
  versionInput,
  summaryInput,
  currentVersion,
  errorMessage,
  cancelButton,
  confirmButton,
  publish,
  onSuccess,
  onError
}) {
  let pendingPublication = null;

  dialog.addEventListener('close', () => {
    pendingPublication = null;
    errorMessage.hidden = true;
  });
  confirmButton.addEventListener('click', confirmPublication);
  versionInput.addEventListener('input', clearError);
  summaryInput.addEventListener('input', clearError);

  return { open };

  function open(publication) {
    pendingPublication = publication;
    projectName.textContent = publication.projectName;
    versionInput.value = publication.suggestedVersion ?? '';
    summaryInput.value = '';
    currentVersion.textContent = publication.currentVersion
      ? `当前公共版本：${publication.currentVersion}`
      : '首次发布，建议从 v1.0.0 开始';
    clearError();
    dialog.showModal();
  }

  async function confirmPublication() {
    if (!pendingPublication) return;
    const validation = validateRelease();
    if (validation) {
      showDialogError(new Error(validation));
      return;
    }
    const publication = {
      ...pendingPublication,
      releaseVersion: versionInput.value.trim(),
      updateSummary: summaryInput.value.trim()
    };
    setBusy(true);
    errorMessage.hidden = true;

    let result;
    try {
      result = await publish(publication);
    } catch (error) {
      showDialogError(error);
      onError(error);
      setBusy(false);
      return;
    }

    dialog.close();
    setBusy(false);
    try {
      await onSuccess(result, publication);
    } catch (error) {
      onError(error);
    }
  }

  function showDialogError(error) {
    errorMessage.textContent = error instanceof Error ? error.message : '发布失败';
    errorMessage.hidden = false;
  }

  function clearError() {
    errorMessage.hidden = true;
    errorMessage.textContent = '';
  }

  function validateRelease() {
    const version = versionInput.value.trim();
    if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/.test(version)) {
      return '请填写有效版本，例如 v1.0.0。';
    }
    if (!summaryInput.value.trim()) return '请说明本次发布的更新内容。';
    return '';
  }

  function setBusy(isBusy) {
    dialog.toggleAttribute('aria-busy', isBusy);
    confirmButton.disabled = isBusy;
    cancelButton.disabled = isBusy;
    confirmButton.textContent = isBusy ? '正在发布…' : '确认发布';
  }
}
