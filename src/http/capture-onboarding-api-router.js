import { readJson, sendJson } from './response.js';

// The person's answer to a new installation's question "FULI 要在哪些项目里
// 记录？" (rec#5 C10). Whether it is open comes with /api/state. Like every
// long-term capture setting it is the person's own console action; no Agent
// tool reaches this route (rec#11 D-16).
export async function handleCaptureOnboardingRequest({ request, response, url, app }) {
  if (url.pathname !== '/api/capture-onboarding' || request.method !== 'POST') return false;
  sendJson(response, 200, app.captureOnboarding.answer(await readJson(request), { surface: 'console' }));
  return true;
}
