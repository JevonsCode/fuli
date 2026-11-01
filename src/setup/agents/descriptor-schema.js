import { z } from 'zod';
import { contentHash } from '../../../packages/roundtable/src/canonical-json.js';
import { packageIdentifier, packageVersion } from '../../employees/manifest.js';
import { deepFreeze } from '../../validation/values.js';
import { CLAUDE_CODE_FULI_PERMISSIONS } from '../claude-code-config.js';
import { codexMcpServerSchema } from './codex/descriptor-schema.js';

// rec#18 D-10: a client descriptor pack is data only. It names where a client
// keeps its files, which built-in probe finds it, what the FULI MCP entry looks
// like and which lifecycle events to register. It never carries a shell
// command, script, remote URL or free path: commands are built by the built-in
// lifecycle entries, paths stay under the home or the client's documented home
// override, and `configWriter` picks one writer from a fixed code set.

const DIGEST_PREFIX = 'sha256:';
const MAX_EVENTS = 8;

const text = (maximum) => z.string().trim().min(1).max(maximum);
const pathSegment = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/)
  .refine((value) => value !== '.' && value !== '..', 'Path segments stay inside their base');
const segments = z.array(pathSegment).min(1).max(6);

export const CLIENT_FILE_KEYS = Object.freeze(['configPath', 'settingsPath', 'hooksPath',
  'globalInstructionsPath', 'globalInstructionsOverridePath', 'pluginPath']);
const pathRef = z.object({ from: z.enum(['homeDir', 'clientHome']), path: segments }).strict();

const detection = z.object({
  // Only client-documented home variables; a pack cannot read any other environment value.
  clientHome: z.object({ from: z.literal('homeDir'), path: segments, envOverride: z.enum(['CODEX_HOME']).optional(),
    // XDG_CONFIG_HOME stands for the home's .config directory, the path's first segment.
    envBase: z.enum(['XDG_CONFIG_HOME']).optional() }).strict()
    .refine((home) => !home.envBase || (home.path[0] === '.config' && home.path.length > 1 && !home.envOverride),
      'XDG_CONFIG_HOME replaces only a leading .config segment'),
  files: z.object(Object.fromEntries(CLIENT_FILE_KEYS.map((key) =>
    [key, key === 'configPath' ? pathRef : pathRef.optional()]))).strict(),
  skillsRoot: pathRef,
  // No longer read: agent-installer detects clients (rec#11 D-79). Accepted
  // so the schema-1 packs already published, and the built-in packs that
  // still carry it, keep their digests; drop it with the next pack schema.
  availableWhen: z.array(z.discriminatedUnion('probe', [
    z.object({ probe: z.literal('commandOnPath') }).strict(),
    z.object({ probe: z.literal('pathExists'), target: z.enum(['clientHome', ...CLIENT_FILE_KEYS]) }).strict()
  ])).min(1).max(8).optional()
}).strict();

// The FULI MCP entry: node runs the packaged MCP server. Placeholders are whole
// strings and are only substituted, never evaluated; literals hold no path.
const argument = z.union([
  z.enum(['{mcpServerPath}', '{runtimeConfigPath}', '{toolProfileArgs}']),
  z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/)
]);
const mcpServer = z.object({
  command: z.literal('{nodePath}'),
  args: z.array(argument).min(1).max(16).refine((args) => args[0] === '{mcpServerPath}', 'The MCP entry starts the packaged server')
}).strict();

const commandSkills = z.object({
  review: z.object({ userCommand: text(40), nativeInvocation: text(40) }).strict(),
  sessionCommand: z.boolean()
}).strict();

function hooks(event, fields = {}) {
  return z.object({
    timeoutSec: z.number().int().min(1).max(600),
    events: z.array(z.object({ event, ...fields }).strict()).min(1).max(MAX_EVENTS)
      .refine((events) => new Set(events.map((item) => item.event)).size === events.length, 'Lifecycle events are unique')
  }).strict();
}
const lifecycleEvent = z.enum(['UserPromptSubmit', 'Stop', 'SessionStart', 'PreCompact']);

const base = {
  schemaVersion: z.literal(1),
  id: packageIdentifier,
  version: packageVersion,
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  label: text(60),
  command: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  detection,
  commandSkills,
  mcpServer
};

const clientDescriptorSchema = z.discriminatedUnion('configWriter', [
  z.object({ ...base, configWriter: z.literal('claude-code-settings'),
    mcpServer: mcpServer.extend({ type: z.literal('stdio') }),
    lifecycleHooks: hooks(lifecycleEvent, { statusMessage: text(80) }),
    // Only the FULI tools the task entry and final checkpoint need; a pack cannot widen permissions.
    permissions: z.object({ allow: z.array(z.enum(CLAUDE_CODE_FULI_PERMISSIONS)).max(CLAUDE_CODE_FULI_PERMISSIONS.length) }).strict() }).strict(),
  z.object({ ...base, configWriter: z.literal('codex-toml'), lifecycleHooks: hooks(lifecycleEvent),
    mcpServer: codexMcpServerSchema(mcpServer),
    instructions: z.object({ global: z.array(z.string().max(200).refine((line) => !line.includes('<!--') && !line.includes('-->'),
      'Instructions cannot contain the managed block markers')).min(1).max(40) }).strict() }).strict(),
  z.object({ ...base, configWriter: z.literal('cursor-hooks'),
    lifecycleHooks: hooks(z.enum(['sessionStart', 'beforeSubmitPrompt', 'stop']), {
      loopLimit: z.number().int().min(1).max(10).optional() }) }).strict(),
  // OpenCode V2 runs lifecycle code as a plugin, not as hook commands: the
  // events name which hooks of the packaged plugin run (rec#11 D-63).
  z.object({ ...base, configWriter: z.literal('opencode-plugin'),
    lifecycleHooks: hooks(z.enum(['prompt', 'execution.succeeded'])) }).strict()
]);

export function descriptorDigest(value) {
  const { digest: _digest, ...content } = value;
  return `${DIGEST_PREFIX}${contentHash(content)}`;
}

// The digest identifies the content for pinning and review; it never proves
// where a pack came from (D-10 §3).
export function parseClientDescriptor(value) {
  const parsed = clientDescriptorSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new TypeError(`Invalid client descriptor pack: ${issue.path.join('.') || '(root)'}: ${issue.message}`);
  }
  if (descriptorDigest(value) !== value.digest) throw new TypeError(`Client descriptor pack ${value.id} does not match its digest`);
  // Keep the authored field order: generated configuration follows it byte for byte.
  return deepFreeze(structuredClone(value));
}
