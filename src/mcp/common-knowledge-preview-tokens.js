import { randomUUID } from 'node:crypto';

import { ApplicationError } from '../app/application-error.js';

const DEFAULT_TTL_MS = 5 * 60 * 1000;

export function createCommonKnowledgePreviewTokens({
  now = Date.now,
  createToken = randomUUID,
  ttlMs = DEFAULT_TTL_MS
} = {}) {
  const previews = new Map();

  return Object.freeze({
    issue(input) {
      pruneExpired(previews, now());
      const token = createToken();
      previews.set(token, {
        expiresAt: now() + ttlMs,
        intent: promotionIntent(input)
      });
      return token;
    },

    consume(token, input) {
      if (!token) {
        throw new ApplicationError(
          'preview_required',
          'Preview this exact common-knowledge promotion before applying it'
        );
      }
      const preview = previews.get(token);
      if (!preview || preview.expiresAt <= now()) {
        previews.delete(token);
        throw new ApplicationError(
          'preview_expired',
          'Common-knowledge preview authorization is missing or expired'
        );
      }
      if (preview.intent !== promotionIntent(input)) {
        throw new ApplicationError(
          'preview_mismatch',
          'Common-knowledge promotion no longer matches its preview'
        );
      }
      previews.delete(token);
    }
  });
}

function promotionIntent(input) {
  return JSON.stringify({
    personalSpaceId: input.personalSpaceId,
    parentProjectId: input.parentProjectId,
    itemKind: input.itemKind,
    canonicalItemId: input.canonicalItemId,
    duplicateItemIds: [...(input.duplicateItemIds ?? [])].sort(),
    reason: input.reason,
    humanConfirmationReason: input.humanConfirmationReason
  });
}

function pruneExpired(previews, currentTime) {
  for (const [token, preview] of previews) {
    if (preview.expiresAt <= currentTime) previews.delete(token);
  }
}
