export function createCaptureControl({ toggle, update, onChange, onError }) {
  let current = true;
  const label = toggle.closest('label');

  toggle.addEventListener('change', () => save(toggle.checked));

  return { render, save };

  function render(policy = { enabled: true }) {
    current = policy.enabled !== false;
    toggle.checked = current;
    toggle.setAttribute('aria-checked', String(current));
    if (label) {
      label.dataset.enabled = String(current);
      label.title = current
        ? '已开启：Agent 会把新的稳定会话知识写入本机'
        : '已关闭：Agent 仍可读取已有知识，但不会写入新的会话内容';
    }
  }

  async function save(enabled = toggle.checked) {
    toggle.disabled = true;
    try {
      const policy = await update(enabled);
      render(policy);
      onChange(policy);
      return policy;
    } catch (error) {
      render({ enabled: current });
      onError(error);
      return null;
    } finally {
      toggle.disabled = false;
    }
  }
}
