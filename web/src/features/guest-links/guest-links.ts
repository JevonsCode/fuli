import { z } from 'zod'

import { deleteJson, getJson, postJson } from '@/api/client'
import { shapeOf } from '@/api/response-shape'
import { t } from '@/i18n'

// Guest links of one project (src/guest-access, rec issue 133): someone on the
// same network without FULI asks this project, read-only, from their own AI.
// The token comes back once, from creation, and is never listed again.
export const DEFAULT_GUEST_LINK_DAYS = 7

const linkSchema = z.looseObject({
  id: z.string(),
  projectId: z.string(),
  label: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  lastUsedAt: z.string().nullable(),
})

const statusFields = {
  listening: z.boolean(),
  addresses: z.array(z.string()),
  problem: z.enum(['no_network', 'port_unavailable', 'unavailable']).nullable(),
}

const listSchema = z.looseObject({ links: z.array(linkSchema), ...statusFields })
const createdSchema = z.looseObject({ link: linkSchema, token: z.string(), ...statusFields })
const listShape = shapeOf(listSchema)
const createdShape = shapeOf(createdSchema)
const revokedShape = shapeOf(z.looseObject({}))

export type GuestLinkList = z.infer<typeof listSchema>
export type CreatedGuestLink = z.infer<typeof createdSchema>

const LINKS_PATH = '/api/visitor-access/guest-links'

export function readGuestLinks(projectId: string) {
  return getJson(`${LINKS_PATH}?${new URLSearchParams({ projectId })}`, listShape)
}

export function createGuestLink(projectId: string, days: number) {
  return postJson(LINKS_PATH, { projectId, days }, createdShape)
}

export function revokeGuestLink(linkId: string) {
  return deleteJson(`${LINKS_PATH}/${encodeURIComponent(linkId)}`, undefined, revokedShape)
}

/** The sentence a person pastes into any AI client that can run commands. */
export function shellSentence(address: string, token: string) {
  return t('guestLinks.shellSentence', { url: `http://${address}/guest/1/search`, token, card: `http://${address}/guest/1/card` })
}
