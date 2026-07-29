import { randomUUID } from 'node:crypto';

import { ApplicationError } from '../app/application-error.js';

const DEFAULT_TTL_MS = 5 * 60 * 1000;

export function createProjectActionPreviewTokens({
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
        intent: projectActionIntent(input)
      });
      return token;
    },

    consume(token, input) {
      if (!token) {
        throw new ApplicationError(
          'preview_required',
          'Preview this exact project action before applying it'
        );
      }
      const preview = previews.get(token);
      if (!preview || preview.expiresAt <= now()) {
        previews.delete(token);
        throw new ApplicationError(
          'preview_expired',
          'Project action preview authorization is missing or expired'
        );
      }
      if (preview.intent !== projectActionIntent(input)) {
        throw new ApplicationError(
          'preview_mismatch',
          'Project action no longer matches its preview'
        );
      }
      previews.delete(token);
    }
  });
}

function projectActionIntent(input) {
  return JSON.stringify({
    personalSpaceId: input.personalSpaceId,
    itemKind: input.itemKind,
    itemId: input.itemId,
    mode: input.mode,
    targetProjectId: input.targetProjectId ?? null,
    newProjectId: input.newProjectId ?? null,
    newProjectName: input.newProjectName ?? null,
    newProjectPurpose: input.newProjectPurpose ?? null,
    keepSourceRelation: input.keepSourceRelation ?? true,
    relationType: input.relationType ?? 'RELATED_TO',
    conflictResolution: input.conflictResolution ?? 'defer',
    reason: input.reason
  });
}

function pruneExpired(previews, currentTime) {
  for (const [token, preview] of previews) {
    if (preview.expiresAt <= currentTime) previews.delete(token);
  }
}
