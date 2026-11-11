import { z } from 'zod';

import { EmployeeError } from '../employees/manifest.js';
import { TONBORG_OPERATIONS } from './backend.js';
import { DELEGATED_LIST_LIMIT, latestDelegatedReviews } from './delegated-reviews.js';
import { plainQuestion } from './question-options.js';
import { parse } from './service.js';
import { visibleKnowledgeKeys } from './visible-items.js';

// 「交给 Tonborg 确认」 (rec#96): the person hands knowledge review to
// Tonborg. With it on, Tonborg's scheduled review decides the clear items the
// way the person would and confirms them as its own (agent_confirmed, never
// the person's confirmation), and asks about the rest in one short batch, each
// as its best guess. Every such decision is a judgment record marked
// delegated, with its reason, undone through /api/judgment/undo.
//
// It spends the tokens of Tonborg's own model, so it can be turned on only
// while one is connected. Turning it on is the person's say-so for Tonborg to
// act by itself: the same click clears 「只给建议」 and acknowledges the trust
// warning (role-trust.js), each recorded in that role's settings history.

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
function tonborgModel(modelTrust) {
  if (!modelTrust) return { connected: false, status: 'suggestion', reason: 'not_configured' };
  const view = modelTrust.view(ROLE, TONBORG_OPERATIONS.review);
  // Without a configured connection the view reads as a session's answer.
  const connected = !['not_configured', 'session_answer'].includes(view.reason);
  return { connected, status: view.status, reason: connected ? view.reason : 'not_configured' };
}

export async function reviewDelegation({ judgment, modelTrust, input }) {
  const { personalSpaceId } = parse(readInput, input);
  await judgment.scope({ personalSpaceId });
  return { ...judgment.store().delegation(personalSpaceId), model: tonborgModel(modelTrust) };
}

export async function setReviewDelegation({ judgment, modelTrust, input }) {
  const { personalSpaceId, enabled, expectedRevision, language } = parse(writeInput, input);
  await judgment.scope({ personalSpaceId });
  // Only turning it on is the say-so; saving it on again (a new language) changes no trust setting.
  if (enabled && !judgment.store().delegation(personalSpaceId).enabled) {
    if (!tonborgModel(modelTrust).connected) {
      throw new EmployeeError('Connect a model for Tonborg first: delegated review runs on Tonborg\'s own model.', 409,
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
  return { ...saved, model: tonborgModel(modelTrust) };
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
