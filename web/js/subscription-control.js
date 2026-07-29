import { deleteJson, postJson } from './api.js';
import { el } from './dom.js';

export function createSubscriptionControl({
  list,
  form,
  projectSelect,
  getState,
  findProject,
  reload,
  onFeedback,
  onError
}) {
  form.addEventListener('submit', subscribeSelected);
  list.addEventListener('click', handleListAction);

  return { render, subscribe, unsubscribe };

  function render(subscriptions) {
    if (!subscriptions.length) {
      list.replaceChildren(el('div', 'empty-state', '尚未订阅团队共享项目'));
      return;
    }
    list.replaceChildren(...subscriptions.map(subscriptionRow));
  }

  async function subscribeSelected(event) {
    event.preventDefault();
    const project = findProject(projectSelect.value);
    if (!project) return;
    try {
      await subscribe(project);
    } catch (error) {
      onError(error);
    }
  }

  async function subscribe(project) {
    const state = getState();
    await postJson('/api/subscriptions', {
      personalSpaceId: state.activePersonalSpaceId,
      projectId: project.id,
      providerUrl: project.providerUrl,
      projectName: project.name
    });
    await reload();
  }

  async function unsubscribe(project) {
    const state = getState();
    const query = new URLSearchParams({
      personalSpaceId: state.activePersonalSpaceId,
      providerUrl: project.providerUrl
    });
    await deleteJson(`/api/subscriptions/${encodeURIComponent(project.id)}?${query}`);
    onFeedback(`已取消订阅“${project.name}”；公共项目内容没有被删除。`);
    await reload();
  }

  async function handleListAction(event) {
    const button = event.target.closest('[data-subscription-action="unsubscribe"]');
    if (!button) return;
    button.disabled = true;
    try {
      await unsubscribe({
        id: button.dataset.projectId,
        providerUrl: button.dataset.providerUrl,
        name: button.dataset.projectName
      });
    } catch (error) {
      onError(error);
      if (button.isConnected) button.disabled = false;
    }
  }
}

function subscriptionRow(subscription) {
  const row = el('div', 'subscription-row');
  const action = el('button', 'secondary-action subscription-action', '取消订阅');
  action.type = 'button';
  action.dataset.subscriptionAction = 'unsubscribe';
  action.dataset.projectId = subscription.project_id;
  action.dataset.providerUrl = subscription.provider_url;
  action.dataset.projectName = subscription.project_name;
  row.append(
    el('span', '', '↗'),
    el('div', '', null, [
      el('strong', '', subscription.project_name),
      el('span', '', '团队共享项目')
    ]),
    action
  );
  return row;
}
