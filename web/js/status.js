import { elements } from './elements.js';

const STATUS_LABELS = Object.freeze({
  loading: '正在连接',
  online: '本地运行中',
  error: '连接失败'
});

export function setRuntimeStatus(status) {
  const label = STATUS_LABELS[status];
  elements.summary.textContent = label;
  elements.runtimeStatus.textContent = label;
  elements.statusDot.className = `status-dot status-${status}`;
}
