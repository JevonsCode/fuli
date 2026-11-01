// FULI's built-in roles by their own names (rec#11 D-89). Copy names a role
// with the linked message @:{'roleNames.jefa'}, never the literal word, so a
// role the person renamed reads by its new name everywhere at once;
// features/agent-profile/role-names.ts replaces these with the current names.
const ROLE_NAMES = { jefa: 'Jefa', bole: 'Bole', tonborg: 'Tonborg', astro: 'Astro' }

export const roleNameMessages = {
  'zh-CN': ROLE_NAMES,
  'en-US': ROLE_NAMES,
} as const
