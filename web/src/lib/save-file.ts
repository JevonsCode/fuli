// Saves a text file the page made (an export) on this computer. Inside the
// FULI desktop client the page asks the client, which writes it to the
// Downloads folder and answers once it is on disk: its WebView cannot save a
// blob link itself (WebView2 has no download event for the client, WKWebView
// drops blob downloads). In a browser it is an ordinary download.

import { desktopBridge } from './desktop-client'

type SavedAnswer = { saved?: boolean, path?: string, error?: string } | null | undefined

export const DESKTOP_SAVE_HANDLER = 'fuliSaveFile'

/** Resolves with where the client saved it, or null for a browser download; rejects if the client could not save. */
export async function saveFile(name: string, content: string, type: string): Promise<string | null> {
  const bridge = desktopBridge()
  if (bridge) {
    const answer = await bridge.callHandler(DESKTOP_SAVE_HANDLER, { name, content, type }) as SavedAnswer
    if (!answer?.saved) throw new Error(answer?.error || 'The desktop client could not save the file')
    return answer.path ?? null
  }
  const url = URL.createObjectURL(new Blob([content], { type }))
  const link = document.createElement('a')
  link.href = url; link.download = name
  document.body.append(link); link.click(); link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
  return null
}
