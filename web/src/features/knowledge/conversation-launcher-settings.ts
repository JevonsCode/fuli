import { readonly, shallowRef } from 'vue'

import { getJson } from '@/api/client'
import type {
  ConversationLauncherConfiguration,
  SystemSettingsResult,
} from '@/types'
import {
  CONVERSATION_SOURCE_APPLICATIONS,
  DEFAULT_CONVERSATION_LAUNCHERS,
} from './source-adapters'

const configuration = shallowRef<ConversationLauncherConfiguration>(
  normalizedConfiguration(DEFAULT_CONVERSATION_LAUNCHERS),
)
let loading: Promise<void> | null = null

export function useConversationLauncherConfiguration() {
  void loadConversationLauncherConfiguration()
  return readonly(configuration)
}

export function setConversationLauncherConfiguration(
  value: ConversationLauncherConfiguration | undefined,
) {
  configuration.value = normalizedConfiguration(value)
}

export function loadConversationLauncherConfiguration({ force = false } = {}) {
  if (!force && loading) return loading
  loading = getJson<SystemSettingsResult>('/api/system/settings')
    .then((result) => {
      setConversationLauncherConfiguration(result.configured.conversationLaunchers)
    })
    .catch(() => undefined)
  return loading
}

function normalizedConfiguration(
  value: ConversationLauncherConfiguration | undefined,
): ConversationLauncherConfiguration {
  return Object.fromEntries(CONVERSATION_SOURCE_APPLICATIONS.map((application) => [
    application,
    {
      ...DEFAULT_CONVERSATION_LAUNCHERS[application],
      ...(value?.[application] ?? {}),
    },
  ])) as ConversationLauncherConfiguration
}
