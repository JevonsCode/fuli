import { readJson, sendJson } from './response.js';

// A new installation's question "FULI 要在哪些项目里记录？" (rec#5 C10).
// Whether it is open also comes with /api/state; GET reads it with the
// settings as saved now, so a console that lost an answer's response can
// show what actually happened. Like every long-term capture setting the
// answer is the person's own console action; no Agent tool (MCP or
// fuli_call) reaches this route (rec#11 D-16).
export async function handleCaptureOnboardingRequest({ request, response, url, app }) {
  if (url.pathname !== '/api/capture-onboarding') return false;
  if (request.method === 'GET') {
    sendJson(response, 200, { ...app.captureOnboarding.state(), capturePolicy: app.getCapturePolicy() });
    return true;
  }
  if (request.method !== 'POST') return false;
  sendJson(response, 200, app.captureOnboarding.answer(await readJson(request), { surface: 'console' }));
  return true;
}

// The console's first-run guide (graphiti/first-run-guide.js): whether it is
// open comes with /api/state; finishing or skipping it closes it for good.
export async function handleFirstRunGuideRequest({ request, response, url, app }) {
  if (url.pathname !== '/api/first-run-guide' || request.method !== 'POST' || !app.firstRunGuide) return false;
  sendJson(response, 200, app.firstRunGuide.close(await readJson(request)));
  return true;
}
