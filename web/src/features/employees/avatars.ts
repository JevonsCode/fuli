import jefaAvatarUrl from '@/assets/jefa-avatar.webp'
import boleAvatarUrl from '@/assets/bole-avatar.webp'
import tonborgAvatarUrl from '@/assets/tonborg-avatar.webp'
import astroAvatarUrl from '@/assets/astro-avatar.webp'

const employeeAvatars: Readonly<Record<string, string>> = {
  jefa: jefaAvatarUrl,
  bole: boleAvatarUrl,
  tonborg: tonborgAvatarUrl,
  assistant: astroAvatarUrl,
}

export function employeeAvatarUrl(templateId: string): string | undefined {
  const id = templateId.replace(/^employee\./, '')
  return Object.hasOwn(employeeAvatars, id) ? employeeAvatars[id] : undefined
}
