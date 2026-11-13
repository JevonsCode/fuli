import { randomBytes, timingSafeEqual } from 'node:crypto';

import { sha256Bytes } from '../security/digest.js';
import { searchableProject } from './shared-project-search.js';

// Guest links: one project of this computer that a person without FULI may
// ask, read-only, from their own AI client on the same network (rec issue
// 133, deliverable B). The token is 'fgl_' and 32 random bytes, shown once at
// creation; only its SHA-256 is stored. Every use reads the link again, so a
// revoked or expired link stops at the next request. The requester key of a
// link's visits is 'guest:<link id>', and a link only asks (mode ask_only).
// Entries answer { ok: true, … } or { ok: false, code }.
const GUEST_LINK_DAYS = Object.freeze([1, 7, 30]);
const DEFAULT_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const TOKEN_PREFIX = 'fgl_';
const TOKEN_BYTES = 32;
const LINK_ID_BYTES = 9;
const TOKEN = /^fgl_[A-Za-z0-9_-]{43}$/;
const LINK_ID = /^[A-Za-z0-9_-]{12}$/;

export function createGuestLinks({ store, now }) {
  return {
    create({ projectId, days = DEFAULT_DAYS } = {}) {
      if (!searchableProject(projectId)) return refused('project_invalid');
      if (!GUEST_LINK_DAYS.includes(days)) return refused('days_invalid');
      const id = randomBytes(LINK_ID_BYTES).toString('base64url');
      const token = `${TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString('base64url')}`;
      const createdAt = now();
      store.insertGuestLink({ id, projectId, tokenHash: sha256Bytes(token), label: `guest-${id.slice(0, 6)}`,
        createdAt: createdAt.toISOString(), expiresAt: new Date(createdAt.getTime() + days * DAY_MS).toISOString() });
      return { ok: true, token, link: linkView(store.liveGuestLinks(createdAt.toISOString(), projectId).find(link => link.id === id)) };
    },

    // Live links (neither revoked nor expired), newest first.
    list({ projectId = null } = {}) {
      if (projectId !== null && !searchableProject(projectId)) return refused('project_invalid');
      return { ok: true, links: store.liveGuestLinks(now().toISOString(), projectId).map(linkView) };
    },

    revoke(id) {
      if (typeof id !== 'string' || !LINK_ID.test(id)) return refused('link_unknown');
      return store.revokeGuestLink(id, now().toISOString()) ? { ok: true } : refused('link_unknown');
    },

    // The live link a bearer token opens, compared in constant time against
    // every live link's hash; its last use is recorded. Any other token, an
    // expired or a revoked one alike, is the same refusal.
    authenticate(token) {
      if (typeof token !== 'string' || !TOKEN.test(token)) return refused('unauthorized');
      const presented = Buffer.from(sha256Bytes(token), 'hex');
      const at = now().toISOString();
      let opened = null;
      for (const link of store.liveGuestLinks(at)) {
        if (timingSafeEqual(presented, Buffer.from(link.tokenHash, 'hex'))) opened = link;
      }
      if (!opened) return refused('unauthorized');
      store.touchGuestLink(opened.id, at);
      return { ok: true, link: linkView({ ...opened, lastUsedAt: at }) };
    },

    // When the set of live links next changes by itself (the earliest expiry), or null.
    nextExpiry() {
      const links = store.liveGuestLinks(now().toISOString());
      return links.length ? links.map(link => link.expiresAt).sort()[0] : null;
    }
  };
}

const refused = code => ({ ok: false, code });

function linkView(link) {
  return { id: link.id, projectId: link.projectId, label: link.label, createdAt: link.createdAt,
    expiresAt: link.expiresAt, lastUsedAt: link.lastUsedAt };
}
