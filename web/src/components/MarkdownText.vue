<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { renderMarkdown } from '@/lib/markdown'

// One Markdown text (lib/markdown.ts sanitizes it). A link to a console page
// opens inside the console; embedded without a router it is a plain link.
const props = defineProps<{ source: string }>()
const router = useRouter() as ReturnType<typeof useRouter> | undefined
const html = computed(() => renderMarkdown(props.source, { consoleHref: path => router?.resolve(path).href ?? path }))

function open(event: MouseEvent) {
  const link = event.target instanceof Element ? event.target.closest<HTMLElement>('a[data-console-path]') : null
  if (!router || !link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  event.preventDefault()
  void router.push(link.dataset.consolePath!)
}
</script>

<template>
  <!-- v-html: renderMarkdown escapes raw HTML and keeps only safe links. -->
  <div class="markdown-text" data-markdown v-html="html" @click="open" />
</template>

<style scoped>
/* Blocks sit close together, like the lines of one message; colours follow the surrounding text. */
.markdown-text { white-space: normal; }
.markdown-text :deep(:is(p, ul, ol, pre, blockquote, table, h1, h2, h3, h4, h5, h6, hr)) { margin: 0; }
.markdown-text :deep(* + :is(p, ul, ol, pre, blockquote, table, h1, h2, h3, h4, h5, h6, hr)) { margin-top: 0.5em; }
.markdown-text :deep(:is(h1, h2, h3, h4, h5, h6)) { font-size: inherit; font-weight: var(--weight-strong); }
.markdown-text :deep(:is(ul, ol)) { padding-left: 1.4em; }
.markdown-text :deep(a) { color: inherit; text-decoration: underline; text-underline-offset: 2px; }
.markdown-text :deep(code) {
  padding: 0.1em 0.35em; border-radius: 4px; background: color-mix(in srgb, currentColor 10%, transparent);
  font-family: var(--font-mono); font-size: 0.92em;
}
.markdown-text :deep(pre) {
  max-width: 100%; padding: 8px 10px; overflow-x: auto; border-radius: var(--radius-control);
  background: color-mix(in srgb, currentColor 8%, transparent); white-space: pre; overflow-wrap: normal;
}
.markdown-text :deep(pre code) { padding: 0; background: none; }
.markdown-text :deep(blockquote) { padding-left: 0.8em; opacity: 0.8; }
.markdown-text :deep(table) { display: block; max-width: 100%; overflow-x: auto; border-collapse: collapse; }
.markdown-text :deep(:is(th, td)) { padding: 2px 8px; border: 1px solid color-mix(in srgb, currentColor 20%, transparent); }
.markdown-text :deep(hr) { border: 0; border-top: 1px solid color-mix(in srgb, currentColor 20%, transparent); }
</style>
