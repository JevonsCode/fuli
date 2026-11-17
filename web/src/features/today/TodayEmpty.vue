<script setup lang="ts">
import { ref } from 'vue'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import NewSessionPanel from '@/features/client-links/NewSessionPanel.vue'
import { t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'

// 今天 with nothing in it: one sentence and one way to start. 说一条试试 hands
// one of the person's AI clients the opening of a habit; the person finishes the
// sentence there. It names no assistant (none may be ready on a new installation)
// and says 记住 / 我的一个习惯 (remember / one of my habits), the words FULI's
// entry reads as a request to keep something, so the AI is asked to record it.
const store = useConsoleStore()
const open = ref(false)
const openedNotice = (client: string) => t('today.empty.opened', { client })
function done(notice: string) {
  open.value = false
  store.notify(notice)
}
</script>

<template>
  <div class="today-empty" data-today-empty>
    <p class="today-empty-text">{{ t('today.empty.text') }}</p>
    <Popover v-model:open="open">
      <PopoverTrigger as-child>
        <Button data-today-try>{{ t('today.empty.try') }}</Button>
      </PopoverTrigger>
      <PopoverContent align="center" :side-offset="8" :collision-padding="12" class="new-session-popover" data-today-try-panel>
        <NewSessionPanel :title="t('today.empty.title')" :lead="t('today.empty.lead')" :ask="t('today.empty.opener')"
          :opened-notice="openedNotice" :copied-notice="t('today.empty.copied')" @done="done" />
      </PopoverContent>
    </Popover>
  </div>
</template>

<style scoped>
/* It sits in the page's flex row (or the feed's column): it takes the width, and its
   rows keep their own height, so the button never stretches to fill the page. */
.today-empty { display: grid; flex: 1; align-content: center; justify-items: center; gap: 16px; padding: clamp(48px, 12vh, 120px) 0; text-align: center; }
.today-empty-text { margin: 0; color: var(--color-ink-soft); font-size: var(--text-body); }
</style>
