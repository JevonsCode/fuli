import { ApplicationError, ApplicationErrorCode } from '../app/application-error.js';
import { selectBoundedJsonArray } from './bounded-json-array.js';
import { sendJson } from './response.js';

const DEFAULT_BUDGET = 1200;
const MAX_BUDGET = 16384;

export function handleLensRequest({ request, response, url, app }) {
  if (url.pathname !== '/api/lens' || request.method !== 'GET') return false;

  const personalSpaceId = app.requireSpaceId({
    id: url.searchParams.get('personalSpaceId'),
    name: url.searchParams.get('personalSpaceName'),
    label: 'Personal space'
  });
  const budget = parseBudget(url.searchParams.get('budget'));
  const view = app.lens.getUserLensView({
    personalSpaceId,
    task: '',
    budget,
    includeObserved: true,
    includeSuggested: false,
    includeRestricted: false
  });
  const bounded = selectBoundedJsonArray(view.entries, budget);

  sendJson(response, 200, {
    personalSpaceId,
    budget,
    usedBytes: bounded.usedBytes,
    truncated: view.truncated || bounded.truncated,
    facts: bounded.items
  });
  return true;
}

function parseBudget(value) {
  if (value === null) return DEFAULT_BUDGET;
  if (!/^[1-9]\d*$/.test(value)) throw invalidBudget();
  const budget = Number(value);
  if (!Number.isSafeInteger(budget) || budget < 2 || budget > MAX_BUDGET) throw invalidBudget();
  return budget;
}

function invalidBudget() {
  return new ApplicationError(
    ApplicationErrorCode.VALIDATION,
    `Budget must be an integer between 2 and ${MAX_BUDGET}`
  );
}
