import { z } from 'zod';
import { JudgmentStore } from './store.js';
import { EmployeeError } from '../employees/manifest.js';
import { judgmentHumanInteraction } from './conversation.js';
import { agentJudgmentView } from './agent-view.js';
import { acceptanceReviewVerdicts } from './review-verdicts.js';
import { taskKnowledgeReader } from '../graphiti/knowledge-reader.js';

const id = z.string().trim().min(1).max(256);
// client: the client Tonborg is enabled for and the CLI an opted-in legacy
// backend runs. Without backend legacy_cli, Tonborg's model or the current
// session answers (D-04 §6); policies saved before this field never run a CLI.
export const policySchema = z.object({ mode: z.enum(['manual', 'shared', 'autonomous']),
  quality: z.enum(['quality', 'balanced', 'economy']), client: z.enum(['codex', 'claude_code']),
  backend: z.enum(['model_or_session', 'legacy_cli']).optional() }).strict();
const spaceSchema = z.object({ personalSpaceId: id }).strict();
const scopeSchema = z.object({ personalSpaceId: id, personalProjectId: id.nullable().optional() });
const projectIdOf = project => project.projectId ?? project.project_id;
const revision = z.number().int().min(0);
// after: the previous page's nextCursor. filter human: only records that wait for the person.
const recordPageSchema = scopeSchema.extend({ limit: z.number().int().min(1).max(100).default(50), after: id.optional(),
  search: z.string().trim().max(200).optional().transform(text => text || undefined),
  filter: z.enum(['all', 'human']).default('all') }).strict();
const pinSchema = z.object({ personalSpaceId: id, agentId: id, pinned: z.boolean(), expectedRevision: revision }).strict();
const policyWriteSchema = scopeSchema.extend({ policy: policySchema.nullable(), expectedRevision: revision }).strict();
const reviewVerdictSchema = z.object({ personalSpaceId: id, agentId: id, personalProjectId: id.nullable().optional() }).strict();
const feedbackSchema = z.object({ personalSpaceId: id, decisionId: id, vote: z.enum(['up', 'down']).nullable(),
  reason: z.string().trim().max(1000).default(''), expectedRevision: revision }).strict();

export function createJudgmentService({ app, openStore = () => new JudgmentStore(), prepareStore = async () => {}, engine } = {}) {
  let database;
  const store = () => database ??= openStore();
  function space(input) {
    if (input.personalSpaceId !== app.config.personal.spaceId) throw new EmployeeError('Use the active personal space', 403, 'scope_mismatch');
  }
  async function projects(personalSpaceId) {
    const result = await app.listPersonalProjects({ personalSpaceId });
    return Array.isArray(result) ? result : result.projects ?? [];
  }
  // The IDs of the space's projects that are not archived: the scopes a policy or review may name.
  async function activeProjectIds(personalSpaceId) {
    return (await projects(personalSpaceId)).filter(p => p.profile?.lifecycle !== 'archived').map(projectIdOf);
  }
  async function scope(input) {
    space(input);
    await prepareStore(input.personalSpaceId);
    if (input.personalProjectId && !(await activeProjectIds(input.personalSpaceId)).includes(input.personalProjectId)) {
      throw new EmployeeError('Project not found', 404, 'project_not_found');
    }
  }
  // The projects whose name contains the searched text. Names live in the
  // Provider; without it the search still covers the records' own words.
  async function projectsNamed(personalSpaceId, text) {
    const wanted = text.toLowerCase();
    try {
      return (await projects(personalSpaceId))
        .filter(project => String(project.profile?.name ?? '').toLowerCase().includes(wanted))
        .map(projectIdOf);
    } catch {
      return [];
    }
  }
  // The scope's own records and the global ones, newest first.
  async function questionRecords(input) {
    const parsed = parse(scopeSchema.strict(), input); await scope(parsed);
    const records = store().records(parsed.personalSpaceId, { personalProjectId: parsed.personalProjectId ?? null });
    if (parsed.personalProjectId) records.push(...store().records(parsed.personalSpaceId, { personalProjectId: null }));
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  // An Agent tool's answer: the records as this reader may read them (agent-view.js).
  const agentView = (result, personalSpaceId, reader = null) =>
    agentJudgmentView(app.personal, result, { personalSpaceId, reader });
  const service = {
    store, scope,
    async pins(input) { space(input); return store().pins(input.personalSpaceId); },
    async pin(input) {
      const parsed = parse(pinSchema, input); space(parsed);
      await prepareStore(parsed.personalSpaceId);
      if (parsed.pinned) {
        const roster = await app.listProjectAgents({ personalSpaceId: parsed.personalSpaceId });
        if (!(Array.isArray(roster) ? roster : roster.agents ?? []).some(agent => agent.agentId === parsed.agentId)) throw new EmployeeError('Agent not found', 404, 'not_found');
      }
      return store().pin(parsed.personalSpaceId, parsed.agentId, parsed.pinned, parsed.expectedRevision);
    },
    async policy(input) { const parsed = parse(scopeSchema.strict(), input); await scope(parsed); return store().policy(parsed.personalSpaceId, parsed.personalProjectId ?? ''); },
    async setPolicy(input) {
      const parsed = parse(policyWriteSchema, input); await scope(parsed);
      if (!parsed.personalProjectId && parsed.policy === null) throw new TypeError('Only project overrides can be removed');
      return store().setPolicy(parsed.personalSpaceId, parsed.personalProjectId ?? '', parsed.policy, parsed.expectedRevision);
    },
    // Tonborg's default policy and every active project's own override.
    async policyOverrides(input) {
      const parsed = parse(spaceSchema, input); await scope(parsed);
      const active = new Set(await activeProjectIds(parsed.personalSpaceId));
      return { default: store().policy(parsed.personalSpaceId),
        overrides: store().policyOverrides(parsed.personalSpaceId).filter(policy => active.has(policy.personalProjectId)) };
    },
    // One page, newest first; nextCursor reads the next page (null at the end).
    async records(input) {
      const { search, filter, ...parsed } = parse(recordPageSchema, input);
      await scope(parsed);
      const page = store().records(parsed.personalSpaceId, { ...parsed, limit: parsed.limit + 1, humanNeeded: filter === 'human',
        search: search ? { text: search, projectIds: await projectsNamed(parsed.personalSpaceId, search) } : null });
      const records = page.slice(0, parsed.limit);
      return { ...judgmentHumanInteraction(records, parsed.personalSpaceId), records,
        nextCursor: page.length > parsed.limit ? records.at(-1).id : null };
    },
    // Reads the local ledger only; no judgment client runs.
    async reviewVerdicts(input) {
      const parsed = parse(reviewVerdictSchema, input); space(parsed);
      await prepareStore(parsed.personalSpaceId);
      return acceptanceReviewVerdicts(store().acceptances(parsed.personalSpaceId, parsed.agentId, parsed.personalProjectId ?? null));
    },
    async feedback(input) { const parsed = parse(feedbackSchema, input); space(parsed);
      await prepareStore(parsed.personalSpaceId);
      return store().feedback(parsed.personalSpaceId, parsed.decisionId, parsed.vote, parsed.reason, parsed.expectedRevision); },
    async review(input) { if (!engine) throw new EmployeeError('Judgment runtime unavailable', 503); return engine.review(service, input); },
    async reviewAutomatic(input) { if (!engine) throw new EmployeeError('Judgment runtime unavailable', 503); return engine.reviewAutomatic(service, input); },
    async assess(input) { if (!engine) throw new EmployeeError('Judgment runtime unavailable', 503); return engine.assess(service, input); },
    async accept(input) { if (!engine) throw new EmployeeError('Judgment runtime unavailable', 503); return engine.accept(service, input); },
    // A session answered a work package Tonborg handed off.
    async resumeWork(work) { if (!engine) throw new EmployeeError('Judgment runtime unavailable', 503); return engine.resume(service, work); },
    // What Agent tools and the session answering Tonborg's work read: the same
    // operations, without the records' words (rec#50). An FLA names itself as
    // search does (projectAgentId in its personalProjectId); else the reader
    // is a plain session. The console reads the full answers above.
    agent: {
      async records({ projectAgentId = null, ...input } = {}) {
        const reader = agentReader(input, projectAgentId);
        return agentView(await service.records(input), input.personalSpaceId, reader);
      },
      async conversationQuestions({ projectAgentId = null, ...input }) {
        const reader = agentReader(input, projectAgentId);
        const { human_interaction } = await agentView({ records: await questionRecords(input) }, input.personalSpaceId, reader);
        return human_interaction ? { human_interaction } : {};
      },
      review: async input => agentView(await service.review(input), input.personalSpaceId),
      assess: async input => agentView(await service.assess(input), input.personalSpaceId),
      accept: async input => agentView(await service.accept(input), input.personalSpaceId),
      // A stored role_work result, fresh or replayed, as the submitting
      // session reads it now: its task's FLA, else a plain session.
      workResult: (result, session) => agentView(result, session.personalSpaceId, taskKnowledgeReader(session))
    },
    close() { database?.close(); }
  };
  return service;
}

const agentReaderSchema = z.object({ personalProjectId: id, projectAgentId: id }).strict();

// The FLA an Agent names, in the one project it reads; null for a plain session.
function agentReader(input, projectAgentId) {
  if (projectAgentId === null) return null;
  return taskKnowledgeReader(parse(agentReaderSchema, { personalProjectId: input.personalProjectId, projectAgentId }));
}

export function parse(schema, input) {
  const result = schema.safeParse(input);
  if (!result.success) throw new TypeError(`Invalid judgment request: ${result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return result.data;
}
