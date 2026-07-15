import { z } from 'zod';

import { rejectDuplicateValues } from './array-validation.js';
import { createCanonicalBase64UrlSchema } from './base64url-contract.js';
import {
  ProviderCapability,
  WORKSPACE_PROTOCOL_VERSION,
  WorkspaceRole,
  WorkspaceVisibility,
} from './constants.js';
import {
  idSchema,
  revisionSchema,
  timestampSchema,
} from './scalar-contract.js';
import {
  createPreservedContentTextSchema,
  createPreservedSemanticTextSchema,
} from './text-contract.js';
import { parseProtocolValue } from './validation.js';

const providerIdentifierSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/);
const MAX_HTTPS_URL_LENGTH = 2_048;
const ROLELESS_CAPABILITIES = new Set([
  ProviderCapability.QUERY,
  ProviderCapability.SYNC,
]);

function hasSafeHttpsPath(url) {
  if (/%25/iu.test(url.pathname)) {
    return false;
  }

  let decodedPathname;

  try {
    decodedPathname = decodeURIComponent(url.pathname);
  } catch {
    return false;
  }

  return !/\p{C}/u.test(decodedPathname);
}

const httpsUrlSchema = z
  .string()
  .min(1)
  .max(MAX_HTTPS_URL_LENGTH)
  .transform((value, context) => {
    if (
      !value.startsWith('https://')
      || /(?:\s|\p{C})/u.test(value)
      || value.includes('?')
      || value.includes('#')
      || /%(?![0-9A-Fa-f]{2})/u.test(value)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Expected a canonical HTTPS URL without whitespace, query, or fragment',
      });
      return z.NEVER;
    }

    let url;

    try {
      url = new URL(value);
    } catch {
      context.addIssue({
        code: 'custom',
        message: 'Expected a valid HTTPS URL without credentials',
      });
      return z.NEVER;
    }

    if (
      url.username !== ''
      || url.password !== ''
      || !hasSafeHttpsPath(url)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Expected a valid HTTPS URL without credentials',
      });
      return z.NEVER;
    }

    const canonicalUrl = url.href;

    if (canonicalUrl.length > MAX_HTTPS_URL_LENGTH) {
      context.addIssue({
        code: 'custom',
        message: 'Canonical HTTPS URL exceeds the maximum length',
      });
      return z.NEVER;
    }

    return canonicalUrl;
  });

const protocolVersionsSchema = z
  .array(z.literal(WORKSPACE_PROTOCOL_VERSION))
  .min(1)
  .max(4)
  .superRefine(rejectDuplicateValues);

const capabilitiesSchema = z
  .array(z.enum(Object.values(ProviderCapability)))
  .min(1)
  .max(8)
  .superRefine(rejectDuplicateValues);

const signingKeySchema = z.strictObject({
  keyId: idSchema,
  algorithm: z.literal('EdDSA'),
  publicJwk: z.strictObject({
    kty: z.literal('OKP'),
    crv: z.literal('Ed25519'),
    x: createCanonicalBase64UrlSchema(32),
  }),
});

const signingKeysSchema = z
  .array(signingKeySchema)
  .max(8)
  .superRefine((keys, context) => {
    rejectDuplicateValues(
      keys.map(({ keyId }) => keyId),
      context,
      (index) => [index, 'keyId'],
    );
  });

export const providerManifestSchema = z.strictObject({
  providerId: providerIdentifierSchema,
  displayName: createPreservedSemanticTextSchema(100),
  protocolVersions: protocolVersionsSchema,
  apiBaseUrl: httpsUrlSchema,
  webBaseUrl: httpsUrlSchema,
  oidc: z.strictObject({
    issuer: httpsUrlSchema,
    audience: createPreservedSemanticTextSchema(200),
  }),
  capabilities: capabilitiesSchema,
  signingKeys: signingKeysSchema,
});

export const workspaceDescriptorSchema = z
  .strictObject({
    id: idSchema,
    slug: providerIdentifierSchema,
    name: createPreservedSemanticTextSchema(120),
    description: createPreservedContentTextSchema(1_000).nullable(),
    visibility: z.enum(Object.values(WorkspaceVisibility)),
    role: z.enum(Object.values(WorkspaceRole)).nullable(),
    capabilities: capabilitiesSchema,
    revision: revisionSchema,
    updatedAt: timestampSchema,
  })
  .superRefine((workspace, context) => {
    if (workspace.role !== null) {
      return;
    }

    workspace.capabilities.forEach((capability, index) => {
      if (!ROLELESS_CAPABILITIES.has(capability)) {
        context.addIssue({
          code: 'custom',
          path: ['capabilities', index],
          message: 'A roleless workspace cannot expose member capabilities',
        });
      }
    });
  });

export function parseProviderManifest(value) {
  return parseProtocolValue(providerManifestSchema, value, 'Provider Manifest');
}

export function parseWorkspaceDescriptor(value) {
  return parseProtocolValue(
    workspaceDescriptorSchema,
    value,
    'Workspace descriptor',
  );
}
