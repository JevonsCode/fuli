import { listAgentTools } from '../agent-tools.js';
import {
  mcpHostSessionId,
  normalizeAgentSessionInput,
  normalizeMcpSourceApplication
} from './session-id.js';
import { assertToolInputWithinBudget, createToolInputValidator } from './tool-input-budget.js';
import { nativeSessionFromEnv } from '../agents/native-session-env.js';
import { agentHostRequestContext } from '../app/agent-request-context.js';

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
  assertToolInputWithinBudget(input);
  const parsed = await createToolInputValidator(definition.inputSchema).parse(input ?? {});
  if (!parsed.success) throw new TypeError('Input validation error');
  const source = normalizeMcpSourceApplication(sourceApplication);
  const nativeThreadId = nativeSessionFromEnv(source, env);
  const authoritativeHostSessionId = hostSessionId ?? nativeThreadId ?? mcpHostSessionId({});
  return {
    definition,
    requestContext: agentHostRequestContext(null, authoritativeHostSessionId, source),
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
