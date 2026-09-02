import { listAgentTools } from '../agent-tools.js';
import {
  mcpHostSessionId,
  nativeCodexThreadId,
  normalizeAgentSessionInput,
  normalizeMcpSourceApplication
} from './session-id.js';
import { jsonSchemaToZod } from './tool-schema.js';

export async function prepareDirectAgentToolCall({
  toolName,
  input,
  sourceApplication = 'other',
  env = process.env,
  clock = () => new Date(),
  hostSessionId = null
}) {
  const definition = listAgentTools().find((item) => item.name === toolName);
  if (!definition) throw new TypeError('Unknown tool');
  const parsed = await jsonSchemaToZod(definition.inputSchema).safeParseAsync(input ?? {});
  if (!parsed.success) throw new TypeError('Input validation error');
  const source = normalizeMcpSourceApplication(sourceApplication);
  const nativeThreadId = source === 'codex' ? nativeCodexThreadId(env) : null;
  const authoritativeHostSessionId = hostSessionId ?? mcpHostSessionId(
    source === 'codex' ? env : {}
  );
  return {
    definition,
    input: normalizeAgentSessionInput(
      toolName,
      parsed.data,
      nativeThreadId,
      authoritativeHostSessionId,
      clock,
      source
    )
  };
}
