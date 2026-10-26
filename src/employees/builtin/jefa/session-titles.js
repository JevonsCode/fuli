import { randomUUID } from 'node:crypto';

import { singleLine } from '../../../text/single-line.js';
import { EmployeeError } from '../../manifest.js';

// Session titles from the board (docs/employee-agents.md). Jefa only proposes:
// the current client renames its own session natively and reports what it
// saw. Nothing here claims a rename before that report, renames another
// session, edits a client's files, or replaces a title the person set.
const TITLE_MAX_CHARS = 80;
const TITLE_SEPARATOR = ' · ';
const STATUS_EMOJI = Object.freeze({ planned: '🗂️', active: '🚧', blocked: '⛔', review: '👀', done: '✅' });

// input: validated prepare_session_title arguments; items: the linked tasks, read from this project.
export function prepareSessionTitle(store, scope, context, input, items) {
  const { titleMode = 'suggest', titleStyle = 'emoji' } = context.management ?? {};
  if (titleMode === 'off') return { execution: 'off', record: null, action: null };
  const session = context.session;
  if (session?.verified && (session.id !== input.sessionId || session.sourceApplication !== input.sourceApplication)) {
    throw new EmployeeError('A session title can be prepared only for the calling session', 403, 'session_mismatch');
  }
  const title = composeTitle(items, titleStyle);
  const key = { requestId: input.requestId, request: input, sourceApplication: input.sourceApplication, sessionId: input.sessionId };
  const record = store.saveTitleRecord(scope, key, (previous, at) => {
    // A title the person changed after Jefa's last applied one is theirs.
    const manual = input.titleLocked === true || Boolean(previous?.lastAppliedTitle
      && input.currentTitle !== undefined && input.currentTitle !== previous.lastAppliedTitle);
    const status = manual ? 'locked' : input.currentTitle === title ? 'unchanged' : 'ready';
    return {
      id: previous?.id ?? randomUUID(), sourceApplication: input.sourceApplication, sessionId: input.sessionId,
      revision: (previous?.revision ?? 0) + 1, workItemIds: input.workItemIds,
      ...(previous?.lastAppliedTitle ? { lastAppliedTitle: previous.lastAppliedTitle } : {}),
      proposal: { id: randomUUID(), title, status, mode: titleMode, createdAt: at }, updatedAt: at
    };
  });
  const ready = record.proposal.status === 'ready';
  const native = ready && titleMode === 'auto' && input.canRename === true;
  return {
    execution: native ? 'client_required' : ready ? 'suggestion' : record.proposal.status,
    record,
    action: native ? { kind: 'rename_session', sourceApplication: input.sourceApplication, sessionId: input.sessionId,
      title, expectedCurrentTitle: input.currentTitle ?? null, sessionVerified: session?.verified === true } : null
  };
}

// The client's receipt of what it actually did with one ready proposal.
export function reportSessionTitle(store, scope, input) {
  const record = store.saveTitleRecord(scope, { recordId: input.recordId }, (previous, at) => {
    if (!previous) throw new EmployeeError('Session title record not found in this project', 404, 'title_record_not_found');
    if (previous.revision !== input.expectedRevision || previous.proposal.id !== input.proposalId) {
      throw new EmployeeError('The session title proposal changed; prepare it again', 409, 'version_conflict');
    }
    if (previous.proposal.status !== 'ready') {
      throw new EmployeeError('This session title proposal was already settled', 409, 'proposal_settled');
    }
    if (input.outcome === 'applied' && !input.observedTitle) {
      throw new EmployeeError('An applied rename reports the title the client observed', 400, 'observed_title_required');
    }
    const applied = input.outcome === 'applied';
    return {
      ...previous, revision: previous.revision + 1, updatedAt: at,
      ...(applied ? { lastAppliedTitle: input.observedTitle } : {}),
      proposal: { ...previous.proposal, status: `reported_${input.outcome}`, reportedAt: at, receiptSource: input.receiptSource,
        ...(input.observedTitle ? { observedTitle: input.observedTitle } : {}) }
    };
  });
  return { evidence: 'client_reported', record };
}

function composeTitle(items, style) {
  const names = items.map((item) => singleLine(item.title)).join(TITLE_SEPARATOR);
  const lead = style === 'emoji' ? `${STATUS_EMOJI[items[0].status]} ` : '';
  const text = `${lead}${names}`;
  const characters = [...text];
  return characters.length > TITLE_MAX_CHARS ? `${characters.slice(0, TITLE_MAX_CHARS - 1).join('')}…` : text;
}
