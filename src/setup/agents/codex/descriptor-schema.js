import { z } from 'zod';

// The built-in TOML writer's supported stdio settings. Descriptor updates
// cannot introduce URL transports, environment values or arbitrary options.
export function codexMcpServerSchema(stdio) {
  return stdio.extend({
    enabled: z.boolean(),
    required: z.boolean(),
    startup_timeout_sec: z.number().int().min(1).max(3600),
    tool_timeout_sec: z.number().int().min(1).max(3600),
    default_tools_approval_mode: z.enum(['auto', 'prompt'])
  });
}
