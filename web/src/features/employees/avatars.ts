import jefaAvatarUrl from '@/assets/jefa-avatar.webp'

const employeeAvatars: Readonly<Record<string, string>> = {
  jefa: jefaAvatarUrl,
}

export function employeeAvatarUrl(templateId: string): string | undefined {
  return employeeAvatars[templateId]
}
