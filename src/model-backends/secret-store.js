import { rmSync, statSync } from 'node:fs';

import { readJsonFile, writeJsonFileAtomic } from '../storage/json-file.js';
import { createDpapiProtector } from './windows-dpapi.js';

// Model API keys, stored under the FULI data directory and named by a
// secretRef. Windows encrypts each key with DPAPI for the current user; other
// systems keep the file readable by its owner only and refuse it otherwise.
// A failed protection never falls back to a plaintext copy, and no message
// carries the key. The file is not part of config export, sync or backup.

const STORE_VERSION = 1;
const REFERENCE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const MAX_SECRET_LENGTH = 4096;
const OTHER_USERS_MASK = 0o077;

const ownerOnlyFile = Object.freeze({
  scheme: 'owner-only-file-v1',
  protect: async plaintext => plaintext.toString('base64'),
  unprotect: async data => Buffer.from(data, 'base64')
});

class ModelSecretError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ModelSecretError';
    this.code = code;
  }
}

export function secretReference(value, label) {
  if (typeof value !== 'string' || !REFERENCE_PATTERN.test(value)) {
    throw new TypeError(`${label} must be 1-64 letters, digits, dots, dashes or underscores`);
  }
  return value;
}

export function createModelSecretStore({
  path,
  platform = process.platform,
  protector = platform === 'win32' ? createDpapiProtector() : ownerOnlyFile,
  fileMode = existingFileMode
}) {
  const ownerOnly = platform !== 'win32';
  function assertPrivate() {
    const mode = ownerOnly ? fileMode(path) : null;
    if (mode !== null && (mode & OTHER_USERS_MASK) !== 0) {
      throw new ModelSecretError('secret_store_insecure',
        'The model key store can be read by other users. Restrict it to the current user (chmod 600) and try again.');
    }
  }
  function records() {
    const stored = readJsonFile(path, null);
    if (stored === null) return {};
    if (stored?.version !== STORE_VERSION || !stored.secrets || typeof stored.secrets !== 'object') {
      throw new ModelSecretError('secret_unreadable', 'The model key store is not in a supported format.');
    }
    return stored.secrets;
  }
  return {
    async set(ref, secret) {
      secretReference(ref, 'Key reference');
      const value = secretValue(secret);
      assertPrivate();
      const existed = fileMode(path) !== null;
      let data;
      try {
        data = await protector.protect(Buffer.from(value, 'utf8'));
      } catch {
        throw new ModelSecretError('secret_protection_failed', `The key for ${ref} could not be protected. Nothing was saved.`);
      }
      writeJsonFileAtomic(path, { version: STORE_VERSION,
        secrets: { ...records(), [ref]: { scheme: protector.scheme, data, updatedAt: new Date().toISOString() } } });
      try {
        assertPrivate();
      } catch (error) {
        if (!existed) rmSync(path, { force: true });
        throw error;
      }
    },
    async read(ref) {
      secretReference(ref, 'Key reference');
      assertPrivate();
      const record = records()[ref];
      if (!record) return null;
      if (record.scheme !== protector.scheme) {
        throw new ModelSecretError('secret_unreadable',
          `The key for ${ref} was saved with another protection scheme. Save it again with: fuli models set-key ${ref}`);
      }
      try {
        return (await protector.unprotect(record.data)).toString('utf8');
      } catch {
        throw new ModelSecretError('secret_unreadable',
          `The key for ${ref} could not be decrypted. Save it again with: fuli models set-key ${ref}`);
      }
    }
  };
}

function secretValue(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > MAX_SECRET_LENGTH || /[\s\u0000-\u001f\u007f]/.test(text)) {
    throw new TypeError(`The key must be one line of at most ${MAX_SECRET_LENGTH} characters without spaces`);
  }
  return text;
}

function existingFileMode(path) {
  try {
    return statSync(path).mode & 0o777;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}
