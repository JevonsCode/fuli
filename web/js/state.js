import { getJson, postJson } from './api.js';
import { elements } from './elements.js';
import { handleActionError, hideFeedback } from './feedback.js';
import { setRuntimeStatus } from './status.js';
import { isViewActive } from './views.js';

let state = null;
let render = null;
let refreshLens = null;

export function configureState(dependencies) {
  render = dependencies.render;
  refreshLens = dependencies.refreshLens;
}

export function getState() {
  return state;
}

export async function loadState() {
  state = await getJson('/api/state');
  if (state.spaces.length === 0) {
    await ensureStarterSpaces();
    state = await getJson('/api/state');
  }
  render(state);
  setRuntimeStatus('online');
  if (isViewActive('memory')) await refreshLens();
}

async function ensureStarterSpaces() {
  await postJson('/api/bootstrap', {});
}

export async function refreshState() {
  hideFeedback();
  try {
    await reloadState();
  } catch (error) {
    handleActionError(error);
  }
}

export async function reloadState() {
  setRuntimeStatus('loading');
  try {
    await loadState();
  } catch (error) {
    setRuntimeStatus('error');
    throw error;
  }
}
