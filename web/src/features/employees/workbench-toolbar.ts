import { inject, provide, type InjectionKey, type Ref } from 'vue'

// The specialist Agent workbench has one toolbar row under the shell's H1. A
// native panel (Bole, Tonborg) teleports its own actions into that row instead
// of adding a second title row; outside the workbench (previews, tests) there
// is no target and the actions stay in the panel.
const toolbarActionsKey: InjectionKey<Readonly<Ref<HTMLElement | null>>> = Symbol('workbench-toolbar-actions')

export function provideWorkbenchToolbarActions(target: Readonly<Ref<HTMLElement | null>>) {
  provide(toolbarActionsKey, target)
}

export function useWorkbenchToolbarActions(): Readonly<Ref<HTMLElement | null>> | null {
  return inject(toolbarActionsKey, null)
}
