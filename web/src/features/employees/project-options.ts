import type { SelectOption } from '@/components/ui/select'

/** Projects as select options; a name two projects share shows each one's ID beside it. */
export function projectSelectOptions(projects: readonly { id: string; name: string }[]): SelectOption[] {
  const counts = new Map<string, number>()
  for (const project of projects) counts.set(project.name, (counts.get(project.name) ?? 0) + 1)
  return projects.map((project) => ({
    value: project.id,
    label: project.name,
    ...((counts.get(project.name) ?? 0) > 1 ? { meta: project.id } : {}),
  }))
}
