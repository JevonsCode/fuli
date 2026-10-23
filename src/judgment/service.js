import { z } from 'zod';
import { JudgmentStore } from './store.js';
import { EmployeeError } from '../employees/manifest.js';
import { judgmentHumanInteraction } from './conversation.js';
import { acceptanceReviewVerdicts } from './review-verdicts.js';

const id = z.string().trim().min(1).max(256);
// client: the client Tonborg is enabled for and the CLI an opted-in legacy
// backend runs. Without backend legacy_cli, Tonborg's model or the current
// session answers (D-04 §6); policies saved before this field never run a CLI.
export const policySchema = z.object({ mode: z.enum(['manual', 'shared', 'autonomous']),
  quality: z.enum(['quality', 'balanced', 'economy']), client: z.enum(['codex', 'claude_code']),
  backend: z.enum(['model_or_session', 'legacy_cli']).optional() }).strict();
const scopeSchema = z.object({ personalSpaceId: id, personalProjectId: id.nullable().optional() });
const revision = z.number().int().min(0);
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
  async function scope(input) {
    space(input);
    await prepareStore(input.personalSpaceId);
    if (input.personalProjectId) {
      const result = await app.listPersonalProjects({ personalSpaceId: input.personalSpaceId });
      if (!(Array.isArray(result) ? result : result.projects ?? []).some(p => (p.projectId ?? p.project_id) === input.personalProjectId && p.profile?.lifecycle !== 'archived')) {
        throw new EmployeeError('Project not found', 404, 'project_not_found');
      }
    }
  }
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
    async records(input) {
      const parsed = parse(scopeSchema.extend({ limit: z.number().int().min(1).max(100).default(50) }).strict(), input);
      await scope(parsed);
      const records = store().records(parsed.personalSpaceId, parsed);
      return { ...judgmentHumanInteraction(records, parsed.personalSpaceId), records };
    },
    async conversationQuestions(input) {
      const parsed = parse(scopeSchema.strict(), input); await scope(parsed);
      const records = store().records(parsed.personalSpaceId, { personalProjectId: parsed.personalProjectId ?? null });
      if (parsed.personalProjectId) records.push(...store().records(parsed.personalSpaceId, { personalProjectId: null }));
      records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return judgmentHumanInteraction(records, parsed.personalSpaceId);
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
    close() { database?.close(); }
  };
  return service;
}

export function parse(schema, input) {
  const result = schema.safeParse(input);
  if (!result.success) throw new TypeError(`Invalid judgment request: ${result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return result.data;
}
