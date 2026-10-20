<script setup lang="ts">
import { RouterLink, useRouter } from 'vue-router'

// "← <collection>" on a record's own page. When the page was opened from that
// collection, it goes Back, so the collection comes back with its filters,
// scroll and focused card; otherwise it opens the collection. A plain
// RouterLink would push as well as go Back (its handler runs first), so this
// owns the click.
defineOptions({ inheritAttrs: false })
const props = defineProps<{
  to: string
  /** Matches the history entry that counts as the collection. */
  from: RegExp
}>()
const router = useRouter()

function go(event: MouseEvent, navigate: (event?: MouseEvent) => unknown) {
  const back = (router.options.history.state as { back?: unknown } | null)?.back
  if (typeof back === 'string' && props.from.test(back)) {
    event.preventDefault()
    router.back()
    return
  }
  void navigate(event)
}
</script>

<template>
  <RouterLink v-slot="{ href, navigate }" :to="to" custom>
    <a v-bind="$attrs" :href="href" @click="go($event, navigate)"><span aria-hidden="true">←</span> <slot /></a>
  </RouterLink>
</template>
