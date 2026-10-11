import jefaAvatarUrl from '@/assets/jefa-avatar.webp'
import boleAvatarUrl from '@/assets/bole-avatar.webp'
import tonborgAvatarUrl from '@/assets/tonborg-avatar.webp'

const employeeAvatars: Readonly<Record<string, string>> = {
  jefa: jefaAvatarUrl,
  bole: boleAvatarUrl,
  tonborg: tonborgAvatarUrl,
}

export function employeeAvatarUrl(templateId: string): string | undefined {
  return employeeAvatars[templateId.replace(/^employee\./, '')]
}
