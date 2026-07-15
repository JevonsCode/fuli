import { elements } from './elements.js';
import { hideFeedback } from './feedback.js';

let activeView = 'overview';

export function selectView(view) {
  activeView = view;
  syncViewVisibility();
  hideFeedback();
}

export function syncViewVisibility() {
  for (const button of elements.viewButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.view === activeView));
  }
  for (const panel of elements.viewPanels) {
    panel.hidden = panel.dataset.viewPanel !== activeView;
  }
}

export function isViewActive(view) {
  return activeView === view;
}
