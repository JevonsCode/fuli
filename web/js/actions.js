import { postJson } from './api.js';
import { elements } from './elements.js';
import { handleActionError, hideFeedback, showFeedback } from './feedback.js';
import { reloadState } from './state.js';

export async function createSpace(event) {
  event.preventDefault();
  try {
    const name = document.querySelector('#space-name').value.trim();
    const kind = document.querySelector('#space-kind').value;
    if (!name) return;
    await postJson('/api/spaces', { name, kind });
    event.target.reset();
    await reloadState();
  } catch (error) {
    handleActionError(error);
  }
}

export async function subscribe(event) {
  event.preventDefault();
  try {
    await postJson('/api/subscriptions', {
      personalSpaceId: elements.subscriptionPersonal.value,
      spaceId: elements.subscriptionSpace.value
    });
    await reloadState();
  } catch (error) {
    handleActionError(error);
  }
}

export async function decideCandidate(candidateId, decision) {
  try {
    const result = await postJson(`/api/candidates/${candidateId}/decision`, { decision });
    await reloadState();
    showFeedback(formatCandidateDecision(result.candidate));
  } catch (error) {
    handleActionError(error);
  }
}

export async function observeChanges() {
  const button = document.querySelector('#observe-button');
  const originalText = button.textContent;
  hideFeedback();
  button.disabled = true;
  button.textContent = '检查中';
  try {
    const result = await postJson('/api/observe/git-diff', {
      personalSpaceId: elements.activePersonal.value,
      targetSpaceId: null
    });
    showFeedback(result.observed.length ? `发现 ${result.observed.length} 条改动` : '暂无新改动');
    await reloadState();
  } catch (error) {
    handleActionError(error);
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

function formatCandidateDecision(candidate) {
  if (candidate.status === 'synced') return '已同步到项目';
  if (candidate.status === 'personal_only') return '已记入个人';
  if (candidate.status === 'ignored') return '已忽略';
  return '已更新';
}
