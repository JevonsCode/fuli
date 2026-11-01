<script setup lang="ts">
import { RouterLink, useRouter } from 'vue-router'
import { t } from '@/i18n'
import UiIcon from '@/ui/UiIcon.vue'

// The trail above a page that belongs to another: `设置 › 模型与用量`. When the
// parent opened this page, its crumb goes Back, so the parent comes back with
// its filters, scroll and focused card; otherwise it opens the parent. A plain
// RouterLink would push as well as go Back (its handler runs first), so the
// crumb owns the click.
// `current` names this page only where nothing else on screen does: a page the
// shell titles with its record's name (or that names itself) leaves it out, and
// the trail ends on its separator so it still reads as "inside the parent".
export interface BreadcrumbParent {
  label: string
  to: string
  /** Matches the history entry that counts as this parent. */
  from: RegExp
}
const props = defineProps<{ parent: BreadcrumbParent; current?: string }>()
const router = useRouter()

// RouterLink's own guard: a modified or non-primary click stays with the
// browser (a new tab or window).
function opensElsewhere(event: MouseEvent) {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return true
  return event.button !== undefined && event.button !== 0
}

function go(event: MouseEvent, navigate: (event?: MouseEvent) => unknown) {
  if (opensElsewhere(event)) return
  const back = (router.options.history.state as { back?: unknown } | null)?.back
  if (typeof back === 'string' && props.parent.from.test(back)) {
    event.preventDefault()
    router.back()
    return
  }
  void navigate(event)
}
</script>

<template>
  <nav class="breadcrumb" :aria-label="t('common.breadcrumb')" data-breadcrumb>
    <ol class="breadcrumb-trail">
      <li class="breadcrumb-item">
        <RouterLink v-slot="{ href, navigate }" :to="parent.to" custom>
          <a class="breadcrumb-link" :href="href" data-breadcrumb-parent @click="go($event, navigate)">{{ parent.label }}</a>
        </RouterLink>
        <UiIcon name="chevron-right" :size="14" class="breadcrumb-separator" />
      </li>
      <li v-if="current" class="breadcrumb-item" aria-current="page" data-breadcrumb-current>{{ current }}</li>
    </ol>
  </nav>
</template>

<style scoped>
.breadcrumb { min-width: 0; font-size: var(--text-meta); line-height: var(--leading-heading); }
.breadcrumb-trail { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-1, 4px); margin: 0; padding: 0; list-style: none; }
.breadcrumb-item { display: inline-flex; align-items: center; gap: var(--space-1, 4px); min-width: 0; color: var(--color-ink); }
.breadcrumb-link { color: var(--color-muted); text-decoration: none; text-underline-offset: 3px; border-radius: 2px; transition: color var(--motion-fast); }
.breadcrumb-link:hover,
.breadcrumb-link:focus-visible { color: var(--color-ink); text-decoration: underline; }
.breadcrumb-separator { color: var(--color-faint); }
</style>
