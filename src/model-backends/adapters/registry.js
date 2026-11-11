import { anthropicMessagesAdapter } from './anthropic-messages.js';
import { builtinEmbeddingsAdapter } from './builtin-embeddings.js';
import { openAiChatAdapter } from './openai-chat.js';
import { openAiEmbeddingsAdapter } from './openai-embeddings.js';
import { typeSafeSystemOneAdapter } from './typesafe-systemone.js';

// The one place that maps a configured protocol to its adapter.
export const MODEL_ADAPTERS = Object.freeze({
  [openAiChatAdapter.protocol]: openAiChatAdapter,
  [anthropicMessagesAdapter.protocol]: anthropicMessagesAdapter,
  [typeSafeSystemOneAdapter.protocol]: typeSafeSystemOneAdapter,
  [openAiEmbeddingsAdapter.protocol]: openAiEmbeddingsAdapter,
  [builtinEmbeddingsAdapter.protocol]: builtinEmbeddingsAdapter
});
