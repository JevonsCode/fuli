import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';

import {
  parseProviderManifest,
  parseWorkspaceDescriptor,
  ProtocolValidationError,
  ProviderCapability,
  providerManifestSchema,
  workspaceDescriptorSchema,
  WorkspaceRole,
  WorkspaceVisibility,
} from '../src/workspace-protocol/index.js';

const validManifest = {
  providerId: 'formal-memory',
  displayName: 'Formal Memory',
  protocolVersions: ['1'],
  apiBaseUrl: 'https://api.formal.example/v1',
  webBaseUrl: 'https://formal.example',
  oidc: {
    issuer: 'https://auth.formal.example',
    audience: 'formal-workspace-api',
  },
  capabilities: [ProviderCapability.QUERY, ProviderCapability.SYNC],
  signingKeys: [
    {
      keyId: 'primary-2026',
      algorithm: 'EdDSA',
      publicJwk: {
        kty: 'OKP',
        crv: 'Ed25519',
        x: '11qYAYdk9Jd6-S3G0A1R4M6Q6K0x4jHw_qlNN-5w7OQ',
      },
    },
  ],
};

const normalizedManifest = {
  ...validManifest,
  webBaseUrl: 'https://formal.example/',
  oidc: {
    ...validManifest.oidc,
    issuer: 'https://auth.formal.example/',
  },
};

const validWorkspace = {
  id: 'workspace-01J2Y7KZX8F0JQ2M6VC8DZK8B9',
  slug: 'compound-interest',
  name: 'Compound Interest',
  description: null,
  visibility: WorkspaceVisibility.PRIVATE,
  role: WorkspaceRole.MAINTAINER,
  capabilities: [ProviderCapability.QUERY, ProviderCapability.PUBLISH],
  revision: '18446744073709551615',
  updatedAt: '2026-07-11T12:34:56+08:00',
};

function captureProtocolValidationError(run, label) {
  try {
    run();
    assert.fail('Expected protocol validation to fail');
  } catch (error) {
    assert.equal(error instanceof ProtocolValidationError, true);
    assert.equal(error.message, `${label} failed protocol validation`);
    assert.ok(error.issues.length > 0);
    return error;
  }
}

test('provider manifest schema and parser accept the planned manifest', () => {
  assert.deepEqual(providerManifestSchema.parse(validManifest), normalizedManifest);
  assert.deepEqual(parseProviderManifest(validManifest), normalizedManifest);
});

test('provider manifest normalizes every HTTPS URL', () => {
  const parsed = parseProviderManifest({
    ...validManifest,
    apiBaseUrl: 'https://API.FORMAL.EXAMPLE',
    webBaseUrl: 'https://FORMAL.EXAMPLE/workspaces',
    oidc: {
      ...validManifest.oidc,
      issuer: 'https://AUTH.FORMAL.EXAMPLE',
    },
  });

  assert.equal(parsed.apiBaseUrl, 'https://api.formal.example/');
  assert.equal(parsed.webBaseUrl, 'https://formal.example/workspaces');
  assert.equal(parsed.oidc.issuer, 'https://auth.formal.example/');
});

test('provider manifest canonical URL output is bounded and idempotent', () => {
  const unicodeApiBaseUrl = 'https://api.formal.example/\u5de5\u4f5c\u533a';
  const overBudgetUnicodeUrl = `https://api.formal.example/${'\u754c'.repeat(230)}`;
  const parsedOnce = parseProviderManifest({
    ...validManifest,
    apiBaseUrl: unicodeApiBaseUrl,
  });
  const parsedTwice = parseProviderManifest(parsedOnce);

  assert.equal(parsedOnce.apiBaseUrl, new URL(unicodeApiBaseUrl).href);
  assert.ok(parsedOnce.apiBaseUrl.length <= 2_048);
  assert.deepEqual(parsedTwice, parsedOnce);
  assert.ok(overBudgetUnicodeUrl.length <= 2_048);
  assert.ok(new URL(overBudgetUnicodeUrl).href.length > 2_048);

  captureProtocolValidationError(
    () => parseProviderManifest({
      ...validManifest,
      apiBaseUrl: overBudgetUnicodeUrl,
    }),
    'Provider Manifest',
  );
});

test('provider manifest rejects unsafe or ambiguous URL forms', () => {
  const invalidUrls = [
    ['apiBaseUrl', 'http://api.formal.example/v1'],
    ['apiBaseUrl', 'not-a-url'],
    ['apiBaseUrl', 'https:example.com'],
    ['apiBaseUrl', ' https://api.formal.example'],
    ['apiBaseUrl', 'https://api.formal.example '],
    ['apiBaseUrl', 'https://api. formal.example'],
    ['apiBaseUrl', 'https://api.formal.example?mode=sync'],
    ['apiBaseUrl', 'https://api.formal.example#keys'],
    ['apiBaseUrl', `https://api.formal.example/${'a'.repeat(2_048)}`],
    ['webBaseUrl', 'https://user:password@formal.example'],
    ['oidc.issuer', 'https://client:secret@auth.formal.example'],
  ];

  for (const [field, value] of invalidUrls) {
    const manifest = structuredClone(validManifest);

    if (field === 'oidc.issuer') {
      manifest.oidc.issuer = value;
    } else {
      manifest[field] = value;
    }

    captureProtocolValidationError(
      () => parseProviderManifest(manifest),
      'Provider Manifest',
    );
  }
});

test('provider manifest rejects raw, encoded, and double-encoded unsafe URL paths', () => {
  const attackUrls = [
    'https://api.formal.example/unsafe\u202epath',
    'https://api.formal.example/unsafe\ud800path',
    'https://api.formal.example/%E2%80%AE',
    'https://api.formal.example/%00',
    'https://api.formal.example/%2500',
    'https://api.formal.example/%25E2%2580%25AE',
    'https://api.formal.example/%',
    'https://api.formal.example/%G0',
    'https://api.formal.example/%0G',
  ];

  for (const apiBaseUrl of attackUrls) {
    const error = captureProtocolValidationError(
      () => parseProviderManifest({ ...validManifest, apiBaseUrl }),
      'Provider Manifest',
    );
    const serializedError = JSON.stringify({
      message: error.message,
      issues: error.issues,
    });

    assert.equal(serializedError.includes(apiBaseUrl), false);
  }
});

test('provider manifest accepts stable percent-encoded multilingual URL paths', () => {
  const apiBaseUrl = encodeURI(
    'https://api.formal.example/\u5de5\u4f5c\u533a/\u0645\u0633\u0627\u062d\u0629',
  );
  const parsedOnce = parseProviderManifest({ ...validManifest, apiBaseUrl });
  const parsedTwice = parseProviderManifest(parsedOnce);

  assert.equal(parsedOnce.apiBaseUrl, apiBaseUrl);
  assert.deepEqual(parsedTwice, parsedOnce);
});

test('provider manifest rejects unknown and duplicate capabilities', () => {
  for (const capabilities of [
    [ProviderCapability.QUERY, 'delete'],
    [ProviderCapability.QUERY, ProviderCapability.QUERY],
  ]) {
    captureProtocolValidationError(
      () => parseProviderManifest({ ...validManifest, capabilities }),
      'Provider Manifest',
    );
  }
});

test('provider manifest rejects duplicate protocol versions and signing key IDs', () => {
  captureProtocolValidationError(
    () => parseProviderManifest({ ...validManifest, protocolVersions: ['1', '1'] }),
    'Provider Manifest',
  );

  const duplicateKeyError = captureProtocolValidationError(
    () => parseProviderManifest({
      ...validManifest,
      signingKeys: [
        validManifest.signingKeys[0],
        structuredClone(validManifest.signingKeys[0]),
      ],
    }),
    'Provider Manifest',
  );

  assert.deepEqual(
    duplicateKeyError.issues[0].path,
    ['signingKeys', 1, 'keyId'],
  );
});

test('provider manifest signing key IDs use the shared safe ID contract', () => {
  for (const keyId of [' signing-key', 'signing key', 'signing\u200bkey']) {
    captureProtocolValidationError(
      () => parseProviderManifest({
        ...validManifest,
        signingKeys: [{ ...validManifest.signingKeys[0], keyId }],
      }),
      'Provider Manifest',
    );
  }
});

test('provider manifest allows query-only providers without signing keys', () => {
  const parsed = parseProviderManifest({
    ...validManifest,
    capabilities: [ProviderCapability.QUERY],
    signingKeys: [],
  });

  assert.deepEqual(parsed.signingKeys, []);
});

test('provider manifest requires canonical Ed25519 public JWK values', () => {
  const validJwk = validManifest.signingKeys[0].publicJwk;
  const invalidJwks = [
    { ...validJwk, kty: 'RSA' },
    { ...validJwk, crv: 'P-256' },
    { ...validJwk, x: `${validJwk.x.slice(0, -1)}+` },
    { ...validJwk, x: `${validJwk.x}=` },
    { ...validJwk, x: Buffer.alloc(31, 1).toString('base64url') },
    { ...validJwk, x: Buffer.alloc(33, 1).toString('base64url') },
    { ...validJwk, x: `${validJwk.x.slice(0, -1)}R` },
  ];

  for (const publicJwk of invalidJwks) {
    captureProtocolValidationError(
      () => parseProviderManifest({
        ...validManifest,
        signingKeys: [{ ...validManifest.signingKeys[0], publicJwk }],
      }),
      'Provider Manifest',
    );
  }
});

test('provider manifest rejects extra fields throughout strict objects', () => {
  const invalidManifests = [
    { ...validManifest, secret: 'must-not-cross-the-boundary' },
    { ...validManifest, oidc: { ...validManifest.oidc, clientSecret: 'secret' } },
    {
      ...validManifest,
      signingKeys: [{ ...validManifest.signingKeys[0], privateKey: 'secret' }],
    },
    {
      ...validManifest,
      signingKeys: [{
        ...validManifest.signingKeys[0],
        publicJwk: { ...validManifest.signingKeys[0].publicJwk, d: 'secret' },
      }],
    },
  ];

  for (const manifest of invalidManifests) {
    captureProtocolValidationError(
      () => parseProviderManifest(manifest),
      'Provider Manifest',
    );
  }
});

test('workspace descriptor preserves revision as a decimal string', () => {
  assert.deepEqual(workspaceDescriptorSchema.parse(validWorkspace), validWorkspace);

  const parsed = parseWorkspaceDescriptor(validWorkspace);

  assert.deepEqual(parsed, validWorkspace);
  assert.equal(typeof parsed.revision, 'string');
});

test('workspace descriptor rejects secret fields and invalid revisions', () => {
  for (const workspace of [
    { ...validWorkspace, secret: 'must-not-cross-the-boundary' },
    { ...validWorkspace, revision: '01' },
    { ...validWorkspace, id: ' workspace-id' },
    { ...validWorkspace, id: 'workspace-id\u0000' },
  ]) {
    captureProtocolValidationError(
      () => parseWorkspaceDescriptor(workspace),
      'Workspace descriptor',
    );
  }
});

test('workspace descriptor requires unique known effective capabilities', () => {
  for (const workspace of [
    Object.fromEntries(Object.entries(validWorkspace).filter(([key]) => key !== 'capabilities')),
    { ...validWorkspace, capabilities: ['delete'] },
    { ...validWorkspace, capabilities: [ProviderCapability.QUERY, ProviderCapability.QUERY] },
  ]) {
    captureProtocolValidationError(
      () => parseWorkspaceDescriptor(workspace),
      'Workspace descriptor',
    );
  }

  const publicReader = {
    ...validWorkspace,
    visibility: WorkspaceVisibility.PUBLIC,
    role: null,
    capabilities: [ProviderCapability.QUERY],
  };

  assert.deepEqual(parseWorkspaceDescriptor(publicReader), publicReader);
});

test('roleless workspace descriptors reject publish and review capabilities at the capability path', () => {
  for (const [capabilities, invalidIndex] of [
    [[ProviderCapability.QUERY, ProviderCapability.PUBLISH], 1],
    [[ProviderCapability.SYNC, ProviderCapability.REVIEW], 1],
  ]) {
    const error = captureProtocolValidationError(
      () => parseWorkspaceDescriptor({
        ...validWorkspace,
        visibility: WorkspaceVisibility.PUBLIC,
        role: null,
        capabilities,
      }),
      'Workspace descriptor',
    );

    assert.ok(error.issues.some(({ path }) => (
      JSON.stringify(path) === JSON.stringify(['capabilities', invalidIndex])
    )));
  }
});

test('roleless readers and workspace members accept actual capability subsets', () => {
  const descriptors = [
    {
      ...validWorkspace,
      visibility: WorkspaceVisibility.PUBLIC,
      role: null,
      capabilities: [ProviderCapability.QUERY],
    },
    {
      ...validWorkspace,
      visibility: WorkspaceVisibility.PUBLIC,
      role: null,
      capabilities: [ProviderCapability.QUERY, ProviderCapability.SYNC],
    },
    {
      ...validWorkspace,
      role: WorkspaceRole.MEMBER,
      capabilities: [ProviderCapability.PUBLISH, ProviderCapability.REVIEW],
    },
    {
      ...validWorkspace,
      role: WorkspaceRole.MAINTAINER,
      capabilities: [ProviderCapability.PUBLISH, ProviderCapability.REVIEW],
    },
  ];

  for (const descriptor of descriptors) {
    assert.deepEqual(parseWorkspaceDescriptor(descriptor), descriptor);
  }
});

test('manifest semantic and content fields enforce Unicode category C safety', () => {
  const invalidManifests = [
    { ...validManifest, displayName: 'unsafe\u202ename' },
    { ...validManifest, oidc: { ...validManifest.oidc, audience: 'unsafe\u200baudience' } },
  ];
  const invalidWorkspaces = [
    { ...validWorkspace, name: 'unsafe\ue000name' },
    { ...validWorkspace, description: 'unsafe\u202edescription' },
    { ...validWorkspace, description: ' edge description' },
  ];

  for (const manifest of invalidManifests) {
    captureProtocolValidationError(() => parseProviderManifest(manifest), 'Provider Manifest');
  }
  for (const workspace of invalidWorkspaces) {
    captureProtocolValidationError(() => parseWorkspaceDescriptor(workspace), 'Workspace descriptor');
  }

  const multilingualManifest = {
    ...validManifest,
    displayName: '\u6b63\u5f0f \u0627\u0644\u0630\u0627\u0643\u0631\u0629',
    oidc: { ...validManifest.oidc, audience: '\u5de5\u4f5c\u533a \u0645\u0633\u0627\u062d\u0629' },
  };
  const multilingualWorkspace = {
    ...validWorkspace,
    name: '\u590d\u5229 \u0627\u0644\u0641\u0627\u0626\u062f\u0629',
    description: '\u4e2d\u6587  \u0646\u0635',
  };

  assert.equal(parseProviderManifest(multilingualManifest).displayName, multilingualManifest.displayName);
  assert.deepEqual(parseWorkspaceDescriptor(multilingualWorkspace), multilingualWorkspace);
});

test('workspace descriptor accepts zero to three fractional second digits', () => {
  for (const updatedAt of [
    '2026-07-11T12:34:56Z',
    '2026-07-11T12:34:56.1+08:00',
    '2026-07-11T12:34:56.123-05:30',
  ]) {
    const parsed = parseWorkspaceDescriptor({ ...validWorkspace, updatedAt });

    assert.equal(parsed.updatedAt, updatedAt);
  }
});

test('workspace descriptor rejects invalid datetime precision, timezone, and roles', () => {
  for (const workspace of [
    { ...validWorkspace, updatedAt: '2026-07-11T12:34:56' },
    { ...validWorkspace, updatedAt: '2026-07-11T12:34:56.1234Z' },
    { ...validWorkspace, updatedAt: `2026-07-11T12:34:56.${'1'.repeat(40)}Z` },
    { ...validWorkspace, role: 'owner' },
  ]) {
    captureProtocolValidationError(
      () => parseWorkspaceDescriptor(workspace),
      'Workspace descriptor',
    );
  }
});
