import { elements } from './elements.js';

export function showFeedback(message) {
  elements.feedback.textContent = message;
  elements.feedback.classList.add('visible');
}

export function hideFeedback() {
  elements.feedback.textContent = '';
  elements.feedback.classList.remove('visible');
}

export function handleActionError(error) {
  showFeedback(`没处理成功：${formatErrorMessage(error)}`);
}

function formatErrorMessage(error) {
  try {
    return JSON.parse(error.message).error ?? error.message;
  } catch {
    return error.message || '未知错误';
  }
}
