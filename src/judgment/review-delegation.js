import { z } from 'zod';

import { EmployeeError } from '../employees/manifest.js';
import { TONBORG_OPERATIONS } from './backend.js';
import { DELEGATED_LIST_LIMIT, latestDelegatedReviews } from './delegated-reviews.js';
import { plainQuestion } from './question-options.js';
import { reviewReach } from './review-egress.js';
import { parse } from './service.js';
import { visibleKnowledgeKeys } from './visible-items.js';

// 「交给 Tonborg 确认」 (rec#96): the person hands knowledge review to
// Tonborg. With it on, Tonborg's scheduled review decides the clear items the
// way the person would and confirms them as its own (agent_confirmed, never
// the person's confirmation), and asks about the rest in one short batch, each
// as its best guess. Every such decision is a judgment record marked
// delegated, with its reason, undone through /api/judgment/undo.
//
// With a model connected it spends that model's tokens. Without one the
// reviews wait as work packages for the current session, which answers them
// as Tonborg with its own model (Jevons 11-17); nothing runs in between.
// The session stands in only while no model is configured for Tonborg at all
// (role-trust.js). Turning it on is the person's say-so for Tonborg to act by
// itself: the same click clears 「只给建议」 and acknowledges the trust warning,
// each recorded in that role's settings history. An FLA turns it on only by
// relaying the person's words (agent_relayed in the interface catalog).

const id = z.string().trim().min(1).max(256);
const readInput = z.object({ personalSpaceId: id }).strict();
// The console's language goes with each save, so Tonborg asks the person in it.
export const PERSON_LANGUAGES = Object.freeze(['zh-CN', 'en-US']);
// language: the one the console shows now, for the sentence each question asks.
const listInput = readInput.extend({ language: z.enum(PERSON_LANGUAGES).optional() }).strict();
// A row of 待决策 has room to quote more of the item than a chat card.
const ROW_EXCERPT = 48;
const writeInput = readInput.extend({ enabled: z.boolean(), expectedRevision: z.number().int().min(0),
  language: z.enum(PERSON_LANGUAGES).optional() }).strict();
const ROLE = 'tonborg';

// Whether Tonborg has a model of its own for knowledge review, and whether its
// answers apply by themselves now (the trust gate as the settings page reads it).
// sessionStandsIn: no model is configured for Tonborg at all, so with the switch
// on the current session confirms for it; a configured model that is off or not
// allowed the review keeps the session's answers suggestions.
function tonborgModel(modelTrust) {
  if (!modelTrust) return { connected: false, sessionStandsIn: false, status: 'suggestion', reason: 'not_configured' };
  const view = modelTrust.view(ROLE, TONBORG_OPERATIONS.review);
  // Without a configured connection the view reads as a session's answer.
  const connected = !['not_configured', 'session_answer'].includes(view.reason);
  return { connected, sessionStandsIn: modelTrust.sessionMayStandIn(ROLE), status: view.status,
    reason: connected ? view.reason : 'not_configured' };
}

// The switch as the console reads it: its state, Tonborg's model, and which
// active projects that model may read (rec#124: on, it still confirms nothing
// in a project the person did not approve for it). The projects live in the
// Provider; without it reach is null and the switch still reads.
async function delegationView({ judgment, modelTrust, modelBackends }, personalSpaceId, saved) {
  const projectIds = await judgment.activeProjectIds(personalSpaceId).catch(() => null);
  return { ...saved, model: tonborgModel(modelTrust),
    reach: projectIds ? reviewReach(modelBackends, personalSpaceId, projectIds,
      projectId => judgment.store().policy(personalSpaceId, projectId ?? '').backend !== 'legacy_cli') : null };
}

export async function reviewDelegation({ judgment, modelTrust, modelBackends = null, input }) {
  const { personalSpaceId } = parse(readInput, input);
  await judgment.scope({ personalSpaceId });
  return delegationView({ judgment, modelTrust, modelBackends }, personalSpaceId, judgment.store().delegation(personalSpaceId));
}

// Whether the switch is on, for the model page's 执行方式 line. A judgment
// store that cannot be read yet reads as off: the line then says only what
// holds without the switch.
export async function reviewHandedOver(judgment, personalSpaceId) {
  if (!judgment || !personalSpaceId) return false;
  try {
    await judgment.scope({ personalSpaceId });
    return judgment.store().delegation(personalSpaceId).enabled;
  } catch {
    return false;
  }
}

export async function setReviewDelegation({ judgment, modelTrust, modelBackends = null, input }) {
  const { personalSpaceId, enabled, expectedRevision, language } = parse(writeInput, input);
  await judgment.scope({ personalSpaceId });
  // Only turning it on is the say-so; saving it on again (a new language) changes no trust setting.
  if (enabled && !judgment.store().delegation(personalSpaceId).enabled) {
    // Without a model of its own Tonborg's reviews go to the current session,
    // which then confirms as Tonborg (Jevons 11-17). The say-so is kept in the
    // trust store either way; without that store nothing could hold it.
    if (!modelTrust) {
      throw new EmployeeError('Delegated review needs the model trust store, which is unavailable here.', 409,
        'tonborg_model_required');
    }
    let trust = modelTrust.view(ROLE, TONBORG_OPERATIONS.review);
    if (trust.suggestionsOnly) {
      modelTrust.setSuggestionsOnly(ROLE, false, trust.revision);
      trust = modelTrust.view(ROLE, TONBORG_OPERATIONS.review);
    }
    if (!trust.warningSeen) modelTrust.acknowledgeWarning(ROLE, trust.warningVersion, trust.revision);
  }
  const saved = judgment.store().setDelegation(personalSpaceId, enabled, expectedRevision, language);
  return delegationView({ judgment, modelTrust, modelBackends }, personalSpaceId, saved);
}

// What the person's list shows of Tonborg's delegated work: the items it
// confirmed and the questions it asks, the newest review of each item only.
// One the person already voted on, undid, or that went stale is done, and so
// is one whose item they confirmed, dropped or replaced elsewhere (11-06: after
// 全部确认 the list still named them, and the Agents kept asking); a
// confirmation stays listed only while the item is still Tonborg's. Each
// question carries what its row asks (question-options.js): the one sentence
// (ask) and its two choices, the guess first.
export async function delegatedReviewList({ judgment, personal = null, input }) {
  const { personalSpaceId, language } = parse(listInput, input);
  await judgment.scope({ personalSpaceId });
  const latest = latestDelegatedReviews(judgment.store(), personalSpaceId, DELEGATED_LIST_LIMIT);
  // A reader that names no language (the notices) is answered in the one saved with the switch.
  const spoken = language ?? (latest.questions.length ? judgment.store().delegation(personalSpaceId).language : null);
  const entry = record => ({ id: record.id, createdAt: record.createdAt, personalProjectId: record.personalProjectId ?? null,
    target: record.target, title: record.title ?? null, summary: record.summary, confidence: record.confidence ?? null,
    guess: record.guess ?? null, question: record.question ?? null, feedbackRevision: record.feedback.revision });
  const asking = record => {
    const { question, doubt, answers } = plainQuestion(record, spoken, { excerpt: ROW_EXCERPT });
    return { ...entry(record), doubt, ask: question, answers: answers.map(choice => choice.answer) };
  };
  const confirmed = latest.confirmed.map(entry), questions = latest.questions.map(asking);
  if (!personal) return { confirmed, questions };
  // A failed read keeps every entry: the console joins them with the items it shows.
  const { states } = await visibleKnowledgeKeys(personal, { personalSpaceId, reader: null },
    [...confirmed, ...questions].map(entry => entry.target), { withState: true });
  const current = (entry, kind) => {
    const state = states.get(entry.target);
    return state === undefined || (kind === 'confirmed' ? state === 'agent_confirmed' : state === 'pending');
  };
  return { confirmed: confirmed.filter(entry => current(entry, 'confirmed')),
    questions: questions.filter(entry => current(entry, 'question')) };
}
