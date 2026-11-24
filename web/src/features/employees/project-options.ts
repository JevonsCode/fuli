import type { SelectOption } from '@/components/ui/select'
import { temporaryGroupLabel } from '@/features/projects/project-scope-choices'

/** A project as a filter or list offers it: its ID, its shown name, and whether FULI opened it by itself. */
export interface ProjectChoice { id: string; name: string; temporary?: boolean }

/**
 * Projects as select options: projects people made first, in the given order,
 * then temporary ones under one heading the picker folds (`foldGroup` =
 * temporaryGroupLabel()), each findable by its ID. A name two projects share
 * shows each one's ID beside it.
 */
export function projectSelectOptions(projects: readonly ProjectChoice[]): SelectOption[] {
  const counts = new Map<string, number>()
  for (const project of projects) counts.set(project.name, (counts.get(project.name) ?? 0) + 1)
  const option = (project: ProjectChoice): SelectOption => ({
    value: project.id,
    label: project.name,
    ...((counts.get(project.name) ?? 0) > 1 ? { meta: project.id } : {}),
  })
  const group = temporaryGroupLabel()
  return [
    ...projects.filter(project => !project.temporary).map(option),
    ...projects.filter(project => project.temporary).map(project => ({ ...option(project), group, search: project.id })),
  ]
}
