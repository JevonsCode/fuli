import jefaAvatarUrl from '@/assets/jefa-avatar.webp'
import boleAvatarUrl from '@/assets/bole-avatar.webp'

const employeeAvatars: Readonly<Record<string, string>> = {
  jefa: jefaAvatarUrl,
  bole: boleAvatarUrl,
}

export function employeeAvatarUrl(templateId: string): string | undefined {
  return employeeAvatars[templateId]
}
