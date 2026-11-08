import { z } from 'zod'
import type { LocationQuery } from 'vue-router'

import { getJson } from '@/api/client'
import { shapeOf } from '@/api/response-shape'
import { inDesktopClient } from '@/lib/desktop-client'

// 「在客户端打开」: the console in a browser hands the page it shows to this
// computer's FULI desktop client as a fuli:// link, and the client opens it in
// its own window (desktop/flutter console_navigation.dart). The server says
// whether the client opens those links (GET /api/system/desktop-client); a page
// the client already shows offers nothing.

const statusShape = shapeOf(z.looseObject({ opensLinks: z.boolean() }))

// The client and its launcher refuse longer links (desktop/flutter fuli_link.dart).
const MAX_LINK_LENGTH = 2048
// What a fuli:// path segment may not hold once decoded (fuli_link.dart).
const UNSAFE_SEGMENT = /[/\\\u0000-\u001f\u007f]/

/** Whether to offer the button: outside the client, while the client opens fuli:// links. */
export async function offersOpenInApp(): Promise<boolean> {
  if (inDesktopClient()) return false
  try {
    return (await getJson('/api/system/desktop-client', statusShape)).opensLinks
  } catch {
    return false
  }
}

/**
 * The fuli:// link of a console page (its router path and query, never its
 * hash), or null when the client could not read it as one. `/` is `fuli://`,
 * the client's own window.
 */
export function fuliLinkFor(path: string, query: LocationQuery): string | null {
  const segments: string[] = []
  for (const raw of path.split('/')) {
    if (!raw) continue
    let segment: string
    try { segment = decodeURIComponent(raw) } catch { return null }
    if (segment === '.' || segment === '..' || UNSAFE_SEGMENT.test(segment)) return null
    segments.push(encodeURIComponent(segment))
  }
  const pairs = Object.entries(query).flatMap(([key, value]) => (Array.isArray(value) ? value : [value])
    .map((item) => item === null ? encodeURIComponent(key) : `${encodeURIComponent(key)}=${encodeURIComponent(item)}`))
  const link = `fuli://${segments.join('/')}${pairs.length ? `?${pairs.join('&')}` : ''}`
  return link.length > MAX_LINK_LENGTH ? null : link
}
