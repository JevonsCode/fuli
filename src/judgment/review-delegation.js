import { z } from 'zod';

import { EmployeeError } from '../employees/manifest.js';
import { TONBORG_OPERATIONS } from './backend.js';
import { isOpenQuestion } from './conversation.js';
import { parse } from './service.js';

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
const writeInput = readInput.extend({ enabled: z.boolean(), expectedRevision: z.number().int().min(0),
  language: z.enum(PERSON_LANGUAGES).optional() }).strict();
// The newest delegated reviews the list reads; older ones stay on Tonborg's page.
const LIST_LIMIT = 200;
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
// One the person already voted on, undid, or that went stale is done.
// The console joins these with the items still pending, so a question about
// an item the person handled elsewhere is not asked again.
export async function delegatedReviewList({ judgment, input }) {
  const { personalSpaceId } = parse(readInput, input);
  await judgment.scope({ personalSpaceId });
  const seen = new Set();
  const confirmed = [], questions = [];
  for (const record of judgment.store().delegatedReviews(personalSpaceId, LIST_LIMIT)) {
    const subject = `${record.personalProjectId ?? ''}\u0000${record.target}`;
    if (seen.has(subject)) continue;
    seen.add(subject);
    if (record.feedback.vote !== null || record.hard_deleted) continue;
    const entry = { id: record.id, createdAt: record.createdAt, personalProjectId: record.personalProjectId ?? null,
      target: record.target, title: record.title ?? null, summary: record.summary, confidence: record.confidence ?? null,
      guess: record.guess ?? null, question: record.question ?? null, feedbackRevision: record.feedback.revision };
    if (record.execution.status === 'applied') confirmed.push(entry);
    else if (isOpenQuestion(record)) questions.push(entry);
  }
  return { confirmed, questions };
}
