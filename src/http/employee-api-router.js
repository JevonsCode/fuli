import { EmployeeError } from '../employees/manifest.js';
import { readJson, sendJson } from './response.js';

export async function handleEmployeeApiRequest({ request, response, url, app }) {
  const employees = app.employees;
  const apiPath = url.pathname.match(/^\/api\/employee-templates(?:\/([^/]+)\/(recruit|workspace|tools|call))?$/);
  const workspacePath = url.pathname.match(/^\/employee-workspaces\/([^/]+)\/([^/]+)(\/.*)?$/);
  if (!apiPath && !workspacePath) return false;
  if (!employees) throw new EmployeeError('Employee runtime is unavailable', 503, 'runtime_unavailable');
  if (workspacePath) {
    const templateId = decodeEmployeePathSegment(workspacePath[1]);
    const personalProjectId = decodeEmployeePathSegment(workspacePath[2]);
    if (!workspacePath[3]) {
      response.writeHead(308, { location: `${url.pathname}/${url.search}` });
      response.end();
      return true;
    }
    await employees.handleHttp(request, response, {
      templateId,
      personalProjectId,
      relativePath: `${workspacePath[3]}${url.search}`,
      origin: `http://${request.headers.host}`
    });
    return true;
  }
  const input = {
    templateId: apiPath[1] ? decodeEmployeePathSegment(apiPath[1]) : undefined,
    personalSpaceId: url.searchParams.get('personalSpaceId'),
    personalProjectId: url.searchParams.get('personalProjectId')
  };
  let result;
  if (!apiPath[1] && request.method === 'GET') result = await employees.list(input);
  else if (apiPath[2] === 'recruit' && request.method === 'POST') {
    const body = await readJson(request);
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some((key) => !['personalSpaceId', 'personalProjectId', 'personalProjectIds', 'replaceAssignments', 'expectedAssignmentsVersion', 'reactivate', 'management'].includes(key)) ||
      (body.reactivate !== undefined && typeof body.reactivate !== 'boolean')) {
      throw new TypeError('Invalid employee recruitment request');
    }
    result = await employees.recruit({ ...body, templateId: input.templateId });
  } else if (apiPath[2] === 'workspace' && request.method === 'GET') result = await employees.workspace(input);
  else if (apiPath[2] === 'tools' && request.method === 'GET') result = await employees.describeTools(input);
  else if (apiPath[2] === 'call' && request.method === 'POST') {
    const body = await readJson(request);
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some((key) => !['personalSpaceId', 'personalProjectId', 'tool', 'arguments'].includes(key)) ||
      typeof body.tool !== 'string') throw new TypeError('Invalid employee tool call');
    result = await employees.callTool({ ...body, templateId: input.templateId });
  } else {
    sendJson(response, 405, { error: 'Method not allowed' });
    return true;
  }
  sendJson(response, 200, result);
  return true;
}

function decodeEmployeePathSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch (error) {
    if (error instanceof URIError) throw new TypeError('Invalid employee path encoding');
    throw error;
  }
}
