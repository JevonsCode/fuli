import { anthropicMessagesAdapter } from './anthropic-messages.js';
import { openAiChatAdapter } from './openai-chat.js';
import { typeSafeSystemOneAdapter } from './typesafe-systemone.js';

// The one place that maps a configured protocol to its adapter.
export const MODEL_ADAPTERS = Object.freeze({
  [openAiChatAdapter.protocol]: openAiChatAdapter,
  [anthropicMessagesAdapter.protocol]: anthropicMessagesAdapter,
  [typeSafeSystemOneAdapter.protocol]: typeSafeSystemOneAdapter
});
