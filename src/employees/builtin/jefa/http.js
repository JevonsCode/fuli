import { randomUUID } from 'node:crypto';

import { InvalidInputError } from '../../../app/application-error.js';
import { arraySchema, boundedString, enumSchema, objectSchema } from '../../../agent-tools/schema.js';
import { refuseRemoteDecision } from '../../../http/request-policy.js';
import { readJson, sendJson } from '../../../http/response.js';
import { jsonSchemaToZod } from '../../../mcp/tool-schema.js';
import { EmployeeError } from '../../manifest.js';
import { TASK_STATUSES } from './project-board.js';

// Jefa's workspace routes under /employee-workspaces/jefa/<project>/. The host
// has already authorized the project (context.project); a project named in a
// path must be that same one. Marking a task done, creating a public task and
// sharing a project are the person's own decisions on this computer
// (interface-catalog.js, local_user_only); the public projection shows only
// tasks marked public_summary, and only their title, status and priority.
// A move to one of the project's own columns names it in boardColumn too.
const statusBody = jsonSchemaToZod(objectSchema({ status: enumSchema(TASK_STATUSES), boardColumn: boundedString(48) }, ['status']));
const sharingBody = jsonSchemaToZod(objectSchema({ publicShareEnabled: { type: 'boolean' }, acceptsPublicRequests: { type: 'boolean' } },
  ['publicShareEnabled', 'acceptsPublicRequests']));
const workItemBody = jsonSchemaToZod(objectSchema({
  projectId: boundedString(256), title: { ...boundedString(180), minLength: 2 }, summary: { type: 'string', maxLength: 2000 },
  priority: enumSchema(['critical', 'high', 'medium', 'low']), visibility: enumSchema(['private', 'public_summary']),
  acceptanceCriteria: arraySchema(boundedString(500), { maxItems: 20 }), tags: arraySchema(boundedString(60), { maxItems: 12 })
}, ['projectId', 'title']));

export async function handleJefaHttp(store, manifest, request, response, context) {
  const scope = { spaceId: context.personalSpaceId, projectId: context.project.id };
  const path = new URL(context.relativePath, 'http://jefa.invalid').pathname;
  const route = (method, pattern) => request.method === method && path.match(pattern);
  let match;
  if (route('GET', /^\/$/)) {
    // The board lives in the console; this address opens it for the project.
    response.writeHead(302, { location: `/employees/jefa?${new URLSearchParams({ project: scope.projectId })}` });
    response.end();
  } else if (route('GET', /^\/\.well-known\/agent-card\.json$/)) {
    sendJson(response, 200, agentCard(manifest));
  } else if (route('GET', /^\/api\/snapshot$/)) {
    sendJson(response, 200, { snapshot: { projects: [store.sharing(scope)], workItems: store.items(scope) } });
  } else if ((match = route('GET', /^\/api\/public\/([^/]+)$/))) {
    const items = store.publicItems(scope, segment(match[1]));
    if (!items) throw new EmployeeError('This report link is not shared', 404, 'report_not_shared');
    sendJson(response, 200, { project: { id: context.project.id, name: context.project.name }, items, acceptsRequests: false });
  } else if ((match = route('PATCH', /^\/api\/projects\/([^/]+)\/sharing$/))) {
    if (refuseRemoteDecision(request, response, 'Project sharing is changed only on this computer')) return;
    sameProject(scope, segment(match[1]));
    const body = parse(sharingBody, await readJson(request), 'sharing');
    if (body.acceptsPublicRequests) throw new InvalidInputError('Public requests are not supported; pass acceptsPublicRequests false');
    sendJson(response, 200, { project: store.setSharing(scope, body.publicShareEnabled) });
  } else if (route('POST', /^\/api\/work-items$/)) {
    if (refuseRemoteDecision(request, response, 'Tasks are created here only on this computer')) return;
    const { projectId, ...task } = parse(workItemBody, await readJson(request), 'task');
    sameProject(scope, projectId);
    const [workItem] = store.create(scope, { requestId: `person-${randomUUID()}`, tasks: [task], actor: 'person' });
    sendJson(response, 201, { workItem });
  } else if ((match = route('PATCH', /^\/api\/work-items\/([^/]+)\/status$/))) {
    if (refuseRemoteDecision(request, response, 'A task is accepted as done only on this computer')) return;
    const { status, boardColumn } = parse(statusBody, await readJson(request), 'status');
    sendJson(response, 200, { workItem: store.setStatus(scope, segment(match[1]), status, boardColumn) });
  } else {
    sendJson(response, 404, { error: 'Not found', code: 'not_found' });
  }
}

function sameProject(scope, projectId) {
  if (projectId !== scope.projectId) throw new EmployeeError('The project does not match this workspace', 403, 'project_mismatch');
}

function segment(value) {
  try { return decodeURIComponent(value); }
  catch { throw new InvalidInputError('Invalid path encoding; percent-encode each path segment'); }
}

function parse(schema, value, label) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new InvalidInputError(`Invalid ${label} request body`);
  return parsed.data;
}

// Discovery only: Jefa is reached through FULI's call_employee_tool, not a separate A2A endpoint.
function agentCard(manifest) {
  return { name: manifest.name, description: manifest.description, version: manifest.version,
    capabilities: manifest.capabilities, interface: { protocol: 'fuli-mcp', tool: 'call_employee_tool', templateId: manifest.id } };
}
