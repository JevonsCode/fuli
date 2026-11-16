import { shallowRef } from 'vue'

import type { ModelRolesPayload } from './model'

// The role settings as the console last read them, in one copy. The top bar's
// model button and the model page both show it, and each puts in what it
// reads or saves, so the two never disagree: a test or a save on the page
// reaches the button at once, and the button's own read reaches the page.
export const latestModelRoles = shallowRef<ModelRolesPayload | null>(null)
