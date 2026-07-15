export const MCP_INSTRUCTIONS = [
  'Query get_user_lens when personal context can materially affect the task.',
  'Call remember_user_fact when the user explicitly states a durable preference during ordinary work.',
  'Use submit_user_observation for inferred patterns; never confirm inferred observations yourself.',
  'Query only when needed and never load the full context store into a prompt.'
].join(' ');
