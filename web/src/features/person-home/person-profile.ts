import { computed, shallowRef } from 'vue'
import { z } from 'zod'
import { getJson, putJson } from '@/api/client'
import { shapeOf } from '@/api/response-shape'
import { generatedAvatarUrl } from '@/features/agent-profile/agent-avatar'
import type { LookChoice } from '@/features/agent-profile/agent-looks'

// The person's own name and picture (「我」), kept on this computer only and
// read once for the whole console, so the home page, the roundtable seat and
// every other 「我」 change together. A console that cannot read it (another
// device on the LAN, an older local FULI) shows the neutral 「我」 face.
export const PERSON_NAME_MAX_CHARS = 32

const profileSchema = z.looseObject({
  name: z.string(),
  look: z.looseObject({
    kind: z.enum(['generated', 'image', 'default']),
    seed: z.string().optional(),
    imageVersion: z.string().optional(),
  }),
})
type PersonProfile = z.infer<typeof profileSchema>
const profileShape = shapeOf(profileSchema)

export const personProfile = shallowRef<PersonProfile | null>(null)
let loadedSpace = ''
let reading: Promise<void> | null = null

const query = (spaceId: string, extra: Record<string, string> = {}) => new URLSearchParams({ personalSpaceId: spaceId, ...extra })

async function read(spaceId: string) {
  try {
    const profile = await getJson('/api/person-profile?' + query(spaceId), profileShape)
    if (spaceId === loadedSpace) personProfile.value = profile
  } catch {
    // Unreadable here: 「我」 keeps the neutral face and no name.
  }
}

/** Reads the person's profile once per space; a later call for the same space reuses that read. */
export function loadPersonProfile(spaceId: string): Promise<void> {
  if (!spaceId) return Promise.resolve()
  if (spaceId === loadedSpace && reading) return reading
  loadedSpace = spaceId
  personProfile.value = null
  reading = read(spaceId)
  return reading
}

/** Saves the name, the look or both and shows the answer everywhere at once. */
export async function savePersonProfile(spaceId: string, change: { name?: string; look?: LookChoice }): Promise<PersonProfile> {
  const saved = await putJson('/api/person-profile', { personalSpaceId: spaceId, ...change }, profileShape)
  if (spaceId === loadedSpace) personProfile.value = saved
  return saved
}

/** The picture the person shows as 「我」, or null for the neutral face. */
export const personAvatarUrl = computed(() => {
  const look = personProfile.value?.look
  if (look?.kind === 'image' && look.imageVersion) return '/api/person-profile/image?' + query(loadedSpace, { v: look.imageVersion })
  if (look?.kind === 'generated' && look.seed) return generatedAvatarUrl(look.seed)
  return null
})
