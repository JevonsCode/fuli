import { computed, inject, type InjectionKey, type Ref } from 'vue'

// A native modal <dialog> sits in the top layer and makes the rest of the page
// inert, so a popup teleported to <body> opens behind it and can't be reached.
// The dialog offers itself here; popups inside it teleport into it instead.
export const POPUP_HOST: InjectionKey<Ref<HTMLElement | null>> = Symbol('popup-host')

export function usePopupTarget() {
  const host = inject(POPUP_HOST, null)
  return computed(() => host?.value ?? 'body')
}
