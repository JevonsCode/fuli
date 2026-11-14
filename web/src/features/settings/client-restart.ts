import { postJson } from '@/api/client'
import { t } from '@/i18n'

import { restartResultShape, type RestartStatus } from './client-connection-model'

// 「重启并更新」 (rec issue 106), shared by 设置 › 客户端 and the first-run guide's 「重启并接入」:
// quits the client, writes FULI's entry while it is closed, reopens it (the console's loopback route only).
export type RestartOutcome = RestartStatus | 'connect_failed_closed' | 'error'

export async function restartClient(clientId: string): Promise<RestartOutcome> {
  try {
    const result = await postJson('/api/system/client-connection/restart', { clientId }, restartResultShape)
    // A failed write says whether the app FULI closed was reopened; without that it was never closed.
    return result.status !== 'connect_failed' ? result.status
      : result.reopened === false ? 'connect_failed_closed' : result.reopened === true ? 'connect_failed' : 'error'
  } catch {
    return 'error'
  }
}

export function restartOutcomeText(outcome: RestartOutcome, client: string): string {
  return outcome === 'error' ? t('settings.connection.clients.connectError')
    : t(`settings.connection.clients.restartResult.${outcome}`, { client })
}
