<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Button } from '@/components/ui/button'
import { t } from '@/i18n'
const props = defineProps<{ text: string }>()
const expanded = ref(false), overflows = ref(false), content = ref<HTMLElement | null>(null)
let observer: ResizeObserver | undefined
function measure() { if (!expanded.value && content.value) overflows.value = content.value.scrollHeight > content.value.clientHeight + 1 }
watch(() => props.text, () => { expanded.value = false; void nextTick(measure) })
onMounted(() => { measure(); if (typeof ResizeObserver !== 'undefined') { observer = new ResizeObserver(measure); if (content.value) observer.observe(content.value) } })
onBeforeUnmount(() => observer?.disconnect())
</script>
<template>
  <div class="overview-excerpt">
    <p ref="content" :class="{ 'is-clamped': !expanded }">{{ text }}</p>
    <Button v-if="overflows || expanded" variant="link" size="sm" :aria-expanded="expanded" @click="expanded = !expanded">{{ t(expanded ? 'overview.read.less' : 'overview.read.more') }}</Button>
  </div>
</template>
<style scoped>
p { max-width: var(--measure); margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; line-height: var(--leading-prose); }
.is-clamped { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.overview-excerpt :deep(button) { padding-inline: 0; }
@media (pointer: coarse) { .overview-excerpt :deep(button) { min-height: 44px; } }
</style>
