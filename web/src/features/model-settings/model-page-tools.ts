import { z } from 'zod'

import { shapeFor, shapeOf } from '@/api/response-shape'
import { definePageTool, PageToolError } from '@/features/webmcp/page-tool'
import type { PersonalProject } from '@/types'

import {
  MODEL_ROLES, SEMANTIC_ROLE, roleDraft, roleEdit, roleName, rolesSharing, validKeyReference, withConnection, withProject,
  type ModelRoleCheckResult, type ModelRoleId, type ModelRolesPayload, type RoleDraft,
} from './model'
import { modelsInUse } from './model-uses'

// The model page's tools for the browser's AI agent (WebMCP): what a person
// does on this page, so "connect the spare model our team has" can be done by
// their own agent. Role edits and 测试连接 go through the delegation gate
// (model_settings). There is no page tool for a key or for the endpoint
// listing, which sends a saved key to a typed address: those stay the
// person's (rec#10 on fuli#784), and a key is sent only to the origin it was
// saved for (src/model-backends/secret-store.js).

const PROTOCOLS = ['openai_chat', 'anthropic_messages', 'openai_embeddings', 'typesafe_systemone'] as const
// The fields these tools rely on in each answer.
const ROLES_SHAPE = shapeFor<ModelRolesPayload>(z.looseObject({ state: z.string(), revision: z.string().nullable(),
  connections: z.record(z.string(), z.looseObject({})), operations: z.looseObject({}),
  roles: z.array(z.looseObject({ role: z.string(), state: z.string() })) }))
const KEYS_SHAPE = shapeOf(z.looseObject({ saved: z.array(z.string()), origins: z.record(z.string(), z.string().nullable()) }))
const CHECK_SHAPE = shapeFor<ModelRoleCheckResult>(z.looseObject({ ok: z.boolean(), receipt: z.looseObject({ status: z.string() }) }))
const ROLE = z.enum(MODEL_ROLES).describe('assistant is Astro; semantic is 语义搜索 (embeddings).')

export interface ModelPageContext {
  spaceId: () => string
  projects: () => readonly PersonalProject[]
  /** The page reads its settings again after a change. */
  changed: () => void
}

function summary(payload: ModelRolesPayload, keyOrigins: Record<string, string | null>, projects: readonly PersonalProject[]) {
  return {
    revision: payload.revision,
    state: payload.state,
    roles: payload.roles.map(view => ({
      role: view.role, name: roleName(view.role), state: view.state, connectionId: view.connection?.id ?? null,
      model: view.connection?.model ?? null, endpointHost: view.connection?.endpointHost ?? null, secretRef: view.connection?.secretRef ?? null,
      operations: view.allowedOperations ?? payload.operations[view.role] ?? [],
      approvedProjects: (view.egress?.approvedProjects ?? []).map(project => project.personalProjectId),
      allowUnassigned: view.egress?.allowUnassigned ?? false, health: view.health?.status ?? null,
    })),
    connections: Object.fromEntries(Object.entries(payload.connections).map(([id, connection]) =>
      [id, { protocol: connection.protocol, endpoint: connection.endpoint, model: connection.model, secretRef: connection.secretRef }])),
    modelsInUse: modelsInUse(payload).map(entry => ({ connectionId: entry.id, model: entry.model, uses: entry.uses })),
    // Each saved key name and the origin it is sent to; a connection may name a key only for that origin.
    savedKeys: keyOrigins,
    projects: projects.map(project => ({ id: project.project_id, name: project.profile.name })),
  }
}

const CONFIGURE = z.object({
  role: ROLE,
  connectionId: z.string().trim().min(1).max(64).optional()
    .describe('Reuse or name a connection; other roles on the same connection change with it.'),
  protocol: z.enum(PROTOCOLS).optional(),
  endpoint: z.url().optional().describe('Base URL, e.g. https://api.openai.com/v1'),
  model: z.string().trim().min(1).max(200).optional(),
  secretRef: z.string().trim().refine(validKeyReference, 'letters, digits, . _ - (1-64)').optional()
    .describe('Name of a key saved on this computer for the origin of this endpoint (see savedKeys); never the key itself.'),
  enabled: z.boolean().optional(),
  operations: z.array(z.string().trim().min(1)).max(32).optional().describe('What this role sends to its model; see fuli_read_model_settings.'),
  approveProjects: z.array(z.string().trim().min(1)).max(64).optional().describe('Project ids whose content may go to this model.'),
  withdrawProjects: z.array(z.string().trim().min(1)).max(64).optional(),
  allowUnassigned: z.boolean().optional(),
})

function configuredDraft(payload: ModelRolesPayload, input: z.infer<typeof CONFIGURE>, spaceId: string, projects: readonly PersonalProject[]) {
  let draft: RoleDraft = roleDraft(payload, input.role)
  if (input.connectionId && input.connectionId !== draft.connectionId) draft = withConnection(draft, payload, input.connectionId)
  const fields: Partial<RoleDraft> = {
    ...(input.protocol ? { protocol: input.protocol } : {}), ...(input.endpoint ? { endpoint: input.endpoint } : {}),
    ...(input.model ? { model: input.model } : {}), ...(input.secretRef !== undefined ? { secretRef: input.secretRef } : {}),
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    ...(input.operations ? { operations: input.operations.join(', ') } : {}),
    ...(input.allowUnassigned !== undefined ? { allowUnassigned: input.allowUnassigned } : {}),
  }
  draft = { ...draft, ...fields }
  const known = new Set(projects.map(project => project.project_id))
  for (const [ids, approved] of [[input.approveProjects ?? [], true], [input.withdrawProjects ?? [], false]] as const) {
    for (const id of ids) {
      if (!known.has(id)) throw new PageToolError('invalid_input', `Unknown project ${id}; read fuli_read_model_settings for project ids`)
      draft = withProject(draft, { personalSpaceId: spaceId, personalProjectId: id }, approved)
    }
  }
  return draft
}

export function modelPageTools(page: ModelPageContext) {
  return [
    definePageTool({
      name: 'fuli_read_model_settings',
      title: 'Read FULI model settings',
      description: 'Every built-in Agent role (Astro=assistant, Jefa, Tonborg, Bole, semantic search) with its state, connection, model, key name, operations and approved projects; saved key names with the origin each may be sent to (never keys), and the project ids.',
      input: z.object({}),
      routes: ['GET /api/model-backends/roles', 'GET /api/model-backends/keys'],
      readOnly: true,
      async run(_input, context) {
        const [payload, keys] = await Promise.all([context.read('/api/model-backends/roles', ROLES_SHAPE),
          context.read('/api/model-backends/keys', KEYS_SHAPE)])
        return summary(payload, keys.origins, page.projects())
      },
    }),
    definePageTool({
      name: 'fuli_configure_model_role',
      title: 'Connect or change a role\'s model',
      description: 'Set a built-in Agent role\'s connection (protocol, endpoint, model, secretRef), switch it on or off, choose its operations and which projects may send content to it. Omitted fields stay as they are. Then test it with fuli_test_model_role.',
      input: CONFIGURE,
      routes: ['GET /api/model-backends/roles', 'PUT /api/model-backends/roles/:role'],
      async run(input, context) {
        const payload = await context.read('/api/model-backends/roles', ROLES_SHAPE)
        const draft = configuredDraft(payload, input, page.spaceId(), page.projects())
        if (input.role === SEMANTIC_ROLE && draft.protocol !== 'openai_embeddings') {
          throw new PageToolError('invalid_input', 'semantic takes the openai_embeddings protocol')
        }
        const saved = await context.change({ route: 'PUT /api/model-backends/roles/:role', params: { role: input.role }, shape: ROLES_SHAPE,
          body: roleEdit(draft, payload.revision) })
        page.changed()
        const view = saved.roles.find(entry => entry.role === input.role)
        return { role: input.role, state: view?.state, model: view?.connection?.model ?? null,
          sharedWith: rolesSharing(saved, draft.connectionId, input.role as ModelRoleId), history: saved.history ?? null }
      },
    }),
    definePageTool({
      name: 'fuli_test_model_role',
      title: 'Test a role\'s model',
      description: 'Send one fixed test request (no project content) to the role\'s saved connection and answer whether it worked.',
      input: z.object({ role: ROLE }),
      routes: ['POST /api/model-backends/roles/:role/check'],
      async run(input, context) {
        const result = await context.change({ route: 'POST /api/model-backends/roles/:role/check', shape: CHECK_SHAPE,
          params: { role: input.role }, body: {} })
        page.changed()
        return { ok: result.ok, status: result.receipt.status, reason: result.receipt.reason ?? null, actualModel: result.receipt.actualModel ?? null }
      },
    }),
  ]
}
