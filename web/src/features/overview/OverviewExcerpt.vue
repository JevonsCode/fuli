<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import UiButton from '@/ui/UiButton.vue'
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
    <UiButton v-if="overflows || expanded" variant="ghost" :aria-expanded="expanded" @click="expanded = !expanded">{{ t(expanded ? 'overview.read.less' : 'overview.read.more') }}</UiButton>
  </div>
</template>
<style scoped>
p { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.55; }
.is-clamped { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.overview-excerpt :deep(button) { min-height: 44px; margin-top: 4px; }
</style>
