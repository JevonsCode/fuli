import { reactive } from 'vue'

import { getJson, postJson, putJson } from '@/api/client'
import { t } from '@/i18n'

// The npm copies of FULI beside the desktop app (src/desktop/npm-copy-control.js):
// the app already runs their data and clients. The console's notice and the
// Settings card share this one state; outside the desktop app the list is empty.

export interface NpmCopy {
  packageRoot: string
  version: string
  // The bare commands (fl, fuli) a terminal still answers with this copy.
  shellCommands: string[]
  removeCommand: string
  noticeDismissed: boolean
}

export interface NpmCopyRemoval {
  status: 'uninstalled' | 'failed'
  version: string
  manualCommand: string | null
  error?: string
}

export const npmCopies = reactive({
  copies: [] as NpmCopy[],
  loaded: false,
  // The copy being removed, and the last removal that failed, by packageRoot.
  removing: null as string | null,
  failed: {} as Record<string, NpmCopyRemoval>,
})

export async function loadNpmCopies() {
  const answer = await getJson<{ copies: NpmCopy[] }>('/api/system/npm-copies')
  npmCopies.copies = Array.isArray(answer?.copies) ? answer.copies : []
  npmCopies.loaded = true
}

export async function removeNpmCopy(copy: NpmCopy): Promise<NpmCopyRemoval> {
  npmCopies.removing = copy.packageRoot
  try {
    const result = await postJson<NpmCopyRemoval>('/api/system/npm-copies/uninstall', { packageRoot: copy.packageRoot })
    if (result.status === 'uninstalled') {
      delete npmCopies.failed[copy.packageRoot]
      npmCopies.copies = npmCopies.copies.filter(candidate => candidate.packageRoot !== copy.packageRoot)
    } else npmCopies.failed[copy.packageRoot] = result
    return result
  } finally {
    npmCopies.removing = null
  }
}

export async function setNpmNoticeDismissed(copy: NpmCopy, dismissed: boolean) {
  const answer = await putJson<{ copies: NpmCopy[] }>('/api/system/npm-copies/notice', { packageRoot: copy.packageRoot, dismissed })
  npmCopies.copies = answer.copies
}

// Why a removal failed, in plain words; an unknown reason is npm's own last line.
const REASONS = new Set(['npm_not_found', 'still_installed', 'not_npm_global'])
export const removalReason = (code: string | undefined) => code && REASONS.has(code) ? t(`npmCopies.reasons.${code}`) : code ?? ''

// The copy the console's notice speaks about: the first one whose notice is still open.
export const noticeCopy = () => npmCopies.copies.find(copy => !copy.noticeDismissed) ?? null
