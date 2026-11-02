<script setup lang="ts">
import { ref, watch } from 'vue'
import { t } from '@/i18n'
import { personAvatarUrl } from './person-profile'

// The person's face wherever they appear as 「我」: the picture they chose on
// their home page, or the neutral 「我」 face. A picture this console cannot
// load (another device, a removed file) falls back to the face as well.
withDefaults(defineProps<{ size?: number }>(), { size: 20 })
const failed = ref(false)
watch(personAvatarUrl, () => { failed.value = false })
</script>

<template>
  <span class="me-avatar" :style="{ '--me-avatar-size': `${size}px` }" aria-hidden="true" data-me-avatar>
    <img v-if="personAvatarUrl && !failed" :src="personAvatarUrl" alt="" data-me-avatar-picture @error="failed = true" />
    <span v-else class="me-avatar-face" data-me-avatar-face>{{ [...t('common.me.name')][0] }}</span>
  </span>
</template>

<style scoped>
.me-avatar {
  display: inline-grid; flex: 0 0 auto; width: var(--me-avatar-size); height: var(--me-avatar-size); overflow: hidden;
  place-items: center; border-radius: 50%; background: var(--color-surface-subtle);
  box-shadow: inset 0 0 0 1px var(--color-border);
}
.me-avatar img { width: 100%; height: 100%; object-fit: cover; }
.me-avatar-face {
  color: var(--color-ink-soft); font-size: calc(var(--me-avatar-size) * .46); font-weight: var(--weight-strong); line-height: 1;
  -webkit-user-select: none; user-select: none;
}
</style>
