import { createSpace, decideCandidate, observeChanges, subscribe } from './js/actions.js';
import { elements } from './js/elements.js';
import { handleActionError } from './js/feedback.js';
import { refreshLens } from './js/lens-view.js';
import { createRenderer } from './js/render.js';
import { configureState, loadState, refreshState } from './js/state.js';
import { setRuntimeStatus } from './js/status.js';
import { isViewActive, selectView } from './js/views.js';

configureState({
  render: createRenderer({ decideCandidate }),
  refreshLens
});

for (const button of elements.viewButtons) {
  button.addEventListener('click', async () => {
    selectView(button.dataset.view);
    if (isViewActive('memory')) await refreshLens();
  });
}

elements.activePersonal.addEventListener('change', async () => {
  if (isViewActive('memory')) await refreshLens();
});
document.querySelector('#observe-button').addEventListener('click', observeChanges);
document.querySelector('#refresh-button').addEventListener('click', refreshState);
document.querySelector('#space-form').addEventListener('submit', createSpace);
document.querySelector('#subscription-form').addEventListener('submit', subscribe);

try {
  await loadState();
} catch (error) {
  setRuntimeStatus('error');
  handleActionError(error);
}
