import { reactive } from 'vue'
import { z } from 'zod'

import { getJson, postJson, putJson } from '@/api/client'
import { shapeOf } from '@/api/response-shape'
import { t } from '@/i18n'

// The npm copies of FULI beside the desktop app (src/desktop/npm-copy-control.js):
// the app already runs their data and clients. The console's notice and the
// Settings card share this one state; outside the desktop app the list is empty.

const npmCopy = z.looseObject({
  packageRoot: z.string(),
  version: z.string(),
  // The bare commands (fl, fuli) a terminal still answers with this copy.
  shellCommands: z.array(z.string()),
  removeCommand: z.string(),
  noticeDismissed: z.boolean(),
  // Its clients use other data, so the app left it and them alone.
  otherDataDir: z.string().nullable(),
  // Newer than the desktop app: the person updates the app first.
  newer: z.boolean(),
})
const listShape = shapeOf(z.looseObject({ copies: z.array(npmCopy) }))
const removal = z.looseObject({
  status: z.enum(['uninstalled', 'failed']),
  version: z.string(),
  manualCommand: z.string().nullable(),
  error: z.string().optional(),
})
const removalShape = shapeOf(removal)

export type NpmCopy = z.infer<typeof npmCopy>
export type NpmCopyRemoval = z.infer<typeof removal>

export const npmCopies = reactive({
  copies: [] as NpmCopy[],
  loaded: false,
  // The copy being removed, and the last removal that failed, by packageRoot.
  removing: null as string | null,
  failed: {} as Record<string, NpmCopyRemoval>,
})

export async function loadNpmCopies() {
  npmCopies.copies = (await getJson('/api/system/npm-copies', listShape)).copies
  npmCopies.loaded = true
}

export async function removeNpmCopy(copy: NpmCopy): Promise<NpmCopyRemoval> {
  npmCopies.removing = copy.packageRoot
  try {
    const result = await postJson('/api/system/npm-copies/uninstall', { packageRoot: copy.packageRoot }, removalShape)
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
  npmCopies.copies = (await putJson('/api/system/npm-copies/notice', { packageRoot: copy.packageRoot, dismissed }, listShape)).copies
}

// Why a removal failed, in plain words; an unknown reason is npm's own last line.
const REASONS = new Set(['npm_not_found', 'still_installed', 'not_npm_global'])
export const removalReason = (code: string | undefined) => code && REASONS.has(code) ? t(`npmCopies.reasons.${code}`) : code ?? ''

// The copy the console's notice speaks about: the first one whose notice is still open.
export const noticeCopy = () => npmCopies.copies.find(copy => !copy.noticeDismissed) ?? null
