<script setup lang="ts">
import { useRouter } from 'vue-router'

import { t } from '@/i18n'

// 「我」 / "Me": the one name for the current person wherever the console
// names them as an actor (Jevons 11-02). It opens their own page; until there
// is a sign-in that is their preferences, on taste. Embedded without a router
// (previews, tests) it is a plain link.
const MY_PAGE = '/preferences?aspect=taste'
const router = useRouter() as ReturnType<typeof useRouter> | undefined
const href = router ? router.resolve(MY_PAGE).href : MY_PAGE

function open(event: MouseEvent) {
  if (!router || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  event.preventDefault()
  void router.push(MY_PAGE)
}
</script>

<template>
  <a class="me-link" :href="href" :aria-label="t('common.me.link')" data-me-link data-term="concept.me" @click="open">{{ t('common.me.name') }}</a>
</template>

<style scoped>
/* A quiet link: it reads as the name, and underlines only when pointed at. */
.me-link { color: inherit; text-decoration: none; -webkit-user-select: none; user-select: none; }
.me-link:hover { text-decoration: underline; text-underline-offset: 2px; }
</style>
