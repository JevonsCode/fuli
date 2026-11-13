import { InvalidInputError } from '../app/application-error.js';
import { compoundingStatement, statementWindow } from '../statement/compounding-statement.js';
import { refuseRemoteDecision } from './request-policy.js';
import { sendJson } from './response.js';

// The person's compounding statement (src/statement). Read only and only on
// this computer, like the workbench's notices: it counts what was done for
// the person. from/to are the person's local week bounds the console computed.
const PATH = '/api/statement';

export async function handleStatementRequest({ request, response, url, app }) {
  if (url.pathname !== PATH) return false;
  response.setHeader('Cache-Control', 'no-store');
  if (refuseRemoteDecision(request, response, 'The statement is read only on this computer')) return true;
  if (request.method !== 'GET') { sendJson(response, 405, { error: 'Method not allowed' }); return true; }
  const params = url.searchParams;
  if (params.has('weeks') && !/^\d{1,2}$/.test(params.get('weeks'))) throw new InvalidInputError('weeks must be a whole number of weeks');
  sendJson(response, 200, await compoundingStatement(app, statementWindow({ from: params.get('from'), to: params.get('to'),
    ...(params.has('weeks') ? { weeks: Number(params.get('weeks')) } : {}) })));
  return true;
}
