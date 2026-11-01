<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'

import { getJson } from '@/api/client'
import ConsoleUpdate from '@/features/update/ConsoleUpdate.vue'
import type { ConsoleUpdateKind } from '@/features/update/model'
import { t } from '@/i18n'
import { fuliLogoUrl } from '@/lib/brand'
import { FULI_VERSION } from '@/version'

interface PackageVersionStatus {
  status: 'ready' | 'unavailable'
  currentVersion: string
  latestVersion: string | null
  updateAvailable: boolean
  packageUrl: string
  checkedAt: string
  // How the console's one-click update installs it (src/system/console-update.js).
  updateKind?: ConsoleUpdateKind
}

// compact: the icon rail shows only the mark; the mark only pops and the effect ends on a short timer,
// and an available update appears as a dot on the mark.
const props = withDefaults(defineProps<{ compact?: boolean }>(), { compact: false })
const root = ref<HTMLElement | null>(null)
const versionButton = ref<HTMLButtonElement | null>(null)
const effectRun = ref(0)
const isPlaying = ref(false)
const isKeyboardFocused = ref(false)
const isUpdateOpen = ref(false)
// While an update runs, its notice stays open to show the progress.
const updating = ref(false)
const versionStatus = ref<PackageVersionStatus | null>(null)
const updateAvailable = computed(() => (
  versionStatus.value?.status === 'ready'
  && versionStatus.value.updateAvailable
  && Boolean(versionStatus.value.latestVersion)
))
const latestVersion = computed(() => versionStatus.value?.latestVersion ?? '')
const packageUrl = computed(() => (
  versionStatus.value?.packageUrl ?? 'https://www.npmjs.com/package/fuli-context'
))
const versionRequestController = new AbortController()
let lastInputWasKeyboard = false

let finishTimer: ReturnType<typeof setTimeout> | undefined
function playEffect() {
  effectRun.value += 1
  isPlaying.value = true
  // With reduced motion the ripple is hidden and fires no animationend.
  clearTimeout(finishTimer)
  if (props.compact) finishTimer = setTimeout(finishEffect, 700)
}

function finishEffect() {
  isPlaying.value = false
}

function toggleUpdateDetails() {
  if (updateAvailable.value && !updating.value) isUpdateOpen.value = !isUpdateOpen.value
}

function handleGlobalPointerDown(event: PointerEvent) {
  lastInputWasKeyboard = false
  isKeyboardFocused.value = false
  if (isUpdateOpen.value && !updating.value && !root.value?.contains(event.target as Node)) {
    isUpdateOpen.value = false
  }
}

function handleGlobalKeyDown(event: KeyboardEvent) {
  if (event.key === 'Tab') lastInputWasKeyboard = true
  if (event.key === 'Escape' && isUpdateOpen.value && !updating.value) {
    event.preventDefault()
    isUpdateOpen.value = false
    void nextTick(() => versionButton.value?.focus())
  }
}

function handleFocus() {
  isKeyboardFocused.value = lastInputWasKeyboard
}

function handleBlur() {
  isKeyboardFocused.value = false
}

onMounted(() => {
  window.addEventListener('pointerdown', handleGlobalPointerDown, true)
  window.addEventListener('keydown', handleGlobalKeyDown, true)
  void getJson<PackageVersionStatus>('/api/system/version', {
    signal: versionRequestController.signal,
  }).then((status) => {
    versionStatus.value = status
  }).catch(() => {
    // Version checks are advisory and must never interrupt the local console.
  })
})

onBeforeUnmount(() => {
  clearTimeout(finishTimer)
  versionRequestController.abort()
  window.removeEventListener('pointerdown', handleGlobalPointerDown, true)
  window.removeEventListener('keydown', handleGlobalKeyDown, true)
})
</script>

<template>
  <div
    ref="root"
    class="brand-block"
    :class="{
      'is-compact': props.compact,
      'is-sparkling': isPlaying,
      'is-keyboard-focused': isKeyboardFocused,
    }"
  >
    <button
      class="brand-effect-button"
      type="button"
      :aria-label="t('console.brandEffect.aria')"
      @click="playEffect"
      @focus="handleFocus"
      @blur="handleBlur"
    >
      <span class="brand-mark-wrap">
        <img class="brand-mark" :src="fuliLogoUrl" alt="" aria-hidden="true" />
        <template v-if="isPlaying">
          <span v-if="!props.compact" :key="`ripple-${effectRun}`" class="brand-ripple" aria-hidden="true" />
        </template>
      </span>
    </button>
    <button v-if="props.compact && updateAvailable" ref="versionButton" class="brand-compact-update" type="button"
      :aria-label="t('console.update.aria', { version: latestVersion })" :aria-expanded="isUpdateOpen"
      aria-controls="brand-update-details" @click="toggleUpdateDetails" />

    <span v-if="!props.compact" class="brand-copy">
      <span class="brand-title-row">
        <span class="brand-name">{{ t('common.brand') }}</span>
        <button
          v-if="updateAvailable"
          ref="versionButton"
          class="brand-version-button"
          type="button"
          :aria-label="t('console.update.aria', { version: latestVersion })"
          :aria-expanded="isUpdateOpen"
          aria-controls="brand-update-details"
          @click="toggleUpdateDetails"
        >
          <span class="brand-version">v{{ FULI_VERSION }}</span>
          <span class="brand-update-dot" aria-hidden="true" />
        </button>
        <span v-else class="brand-version">v{{ FULI_VERSION }}</span>
      </span>
      <span class="brand-subtitle">Context Graph</span>
      <span
        v-if="isPlaying"
        :key="`copy-reflection-${effectRun}`"
        class="brand-copy-reflection"
        aria-hidden="true"
        @animationend.self="finishEffect"
      >
        <span class="brand-title-row">
          <span class="brand-name">{{ t('common.brand') }}</span>
          <span class="brand-version">v{{ FULI_VERSION }}</span>
        </span>
      </span>
    </span>

    <div
      v-if="isUpdateOpen"
      id="brand-update-details"
      class="brand-update-popover"
      role="dialog"
      :aria-label="t('console.update.title', { version: latestVersion })"
    >
      <strong>{{ t('console.update.title', { version: latestVersion }) }}</strong>
      <ConsoleUpdate :version="latestVersion" :kind="versionStatus?.updateKind ?? 'npm'" @busy="updating = $event" />
      <a :href="packageUrl" target="_blank" rel="noopener noreferrer">
        {{ t('console.update.npmLink') }}
      </a>
    </div>
  </div>
</template>

<style scoped>
.brand-block {
  position: relative;
  isolation: isolate;
  display: flex;
  align-items: center;
  gap: 11px;
  width: 100%;
  padding: 0 8px 22px;
  color: inherit;
  text-align: left;
  -webkit-tap-highlight-color: transparent;
}

.brand-block::before {
  content: '';
  position: absolute;
  z-index: -1;
  top: -8px;
  left: 0;
  width: 58px;
  height: 58px;
  border-radius: 50%;
  background: radial-gradient(circle, color-mix(in srgb, var(--brand-gold) 20%, transparent), transparent 68%);
  opacity: 0;
  pointer-events: none;
}

.brand-effect-button {
  appearance: none;
  display: block;
  flex: 0 0 auto;
  padding: 0;
  border: 0;
  color: inherit;
  background: transparent;
  cursor: pointer;
}

.brand-effect-button:focus {
  outline: none;
}

.brand-block.is-keyboard-focused .brand-mark-wrap {
  border-radius: 50%;
  box-shadow: 0 0 0 2px var(--color-accent);
}

.brand-mark-wrap {
  position: relative;
  width: 38px;
  height: 38px;
  flex: 0 0 auto;
}

.brand-mark {
  display: block;
  width: 38px;
  height: 38px;
  object-fit: contain;
}

/* Two rings ripple out from the mark and fade inside the brand area, so the
   effect never leaves a stray dot outside the rail. */
.brand-ripple {
  position: absolute;
  z-index: 3;
  inset: 0;
  border-radius: 50%;
  pointer-events: none;
  animation: brand-ripple-host 1.1s linear both;
}

.brand-ripple::before,
.brand-ripple::after {
  content: '';
  position: absolute;
  inset: 0;
  border: 2px solid var(--color-warning);
  border-radius: 50%;
  opacity: 0;
  animation: brand-ripple .9s cubic-bezier(.2, .7, .3, 1) both;
}

.brand-ripple::after { animation-delay: .18s; }

.brand-copy {
  position: relative;
  display: grid;
  min-width: 0;
}

.brand-title-row {
  display: flex;
  min-width: 0;
  align-items: baseline;
  gap: 7px;
}

.brand-name {
  /* The brand never wraps; a long version label truncates instead. */
  flex: 0 0 auto;
  white-space: nowrap;
  font-size: 18px;
  font-weight: 700;
  letter-spacing: -.02em;
}

.brand-version {
  color: var(--color-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  font-weight: var(--weight-medium);
  letter-spacing: .02em;
  white-space: nowrap;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.brand-version-button {
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin: -2px -1px;
  padding: 2px 1px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  cursor: pointer;
}

.brand-version-button:hover .brand-version {
  color: var(--color-ink);
}

.brand-version-button:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--color-accent);
}

.brand-update-dot {
  width: 5px;
  height: 5px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: var(--color-danger);
  box-shadow: 0 1px 4px color-mix(in srgb, var(--color-danger) 28%, transparent);
}

.brand-subtitle {
  margin-top: 2px;
  color: var(--color-muted);
  font-size: 12px;
}

.brand-copy-reflection {
  position: absolute;
  z-index: 3;
  top: 0;
  right: 0;
  left: 0;
  height: 22px;
  opacity: 0;
  pointer-events: none;
  clip-path: polygon(-26% -20%, -8% -20%, -18% 120%, -36% 120%);
  will-change: clip-path, opacity;
  animation: brand-copy-reflection .62s .62s cubic-bezier(.22, .66, .25, 1) both;
}

.brand-copy-reflection .brand-name,
.brand-copy-reflection .brand-version {
  color: var(--color-warning);
  text-shadow: 0 0 6px color-mix(in srgb, var(--brand-gold) 28%, transparent);
}

/* In the rail the mark only presses and pops: no halo or rings around it. */
.brand-block.is-compact { flex: 0 0 auto; width: auto; justify-content: center; padding: 0; }
.brand-block.is-compact.is-sparkling::before { content: none; }
.brand-block.is-compact .brand-effect-button:active .brand-mark { transform: scale(.9); transition: transform 90ms ease-out; }
.brand-compact-update {
  position: absolute; top: -2px; right: 10px; width: 12px; height: 12px; padding: 0;
  border: 2px solid var(--color-sidebar); border-radius: 50%; background: var(--status-waiting); cursor: pointer;
}
.brand-block.is-compact .brand-update-popover { top: 0; left: 64px; right: auto; width: 260px; }

.brand-update-popover {
  position: absolute;
  z-index: 20;
  top: 45px;
  right: 8px;
  left: 49px;
  padding: 12px;
  border-radius: 12px;
  color: var(--color-ink);
  background: var(--color-surface);
  box-shadow: var(--shadow-popover);
}

.brand-update-popover strong {
  display: block;
  font-size: 12px;
  line-height: 1.45;
}

.brand-update-popover a {
  display: inline-block;
  margin-top: 9px;
  color: var(--color-ink);
  font-size: 12px;
  font-weight: var(--weight-medium);
  text-decoration-thickness: 1px;
  text-underline-offset: 2px;
}

.brand-update-popover a:hover {
  color: var(--color-ink);
}

.brand-update-popover a:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 3px;
  border-radius: 2px;
}

.brand-block.is-sparkling::before {
  animation: brand-halo 1.05s ease-out both;
}

/* The mark itself answers the click: a short compositor-only bounce. */
.brand-block.is-sparkling .brand-mark {
  animation: brand-mark-pop .62s cubic-bezier(.34, 1.56, .64, 1) both;
}

@keyframes brand-mark-pop {
  0% { transform: scale(1) rotate(0deg); }
  35% { transform: scale(1.14) rotate(-8deg); }
  100% { transform: scale(1) rotate(0deg); }
}

@keyframes brand-ripple {
  0% { opacity: .75; transform: scale(.72); }
  100% { opacity: 0; transform: scale(1.22); }
}

@keyframes brand-ripple-host {
  from { opacity: 1; }
  to { opacity: 1; }
}

@keyframes brand-copy-reflection {
  0% { opacity: 0; clip-path: polygon(-26% -20%, -8% -20%, -18% 120%, -36% 120%); }
  14% { opacity: .86; }
  78% { opacity: .68; }
  100% { opacity: 0; clip-path: polygon(132% -20%, 150% -20%, 140% 120%, 122% 120%); }
}

@keyframes brand-halo {
  0% { opacity: 0; transform: scale(.72); }
  34% { opacity: 1; }
  100% { opacity: 0; transform: scale(1.12); }
}

@media (prefers-reduced-motion: reduce) {
  .brand-block.is-sparkling .brand-mark {
    animation: none;
  }

  .brand-ripple {
    display: none;
  }

  .brand-block.is-sparkling::before {
    animation: brand-reduced-halo .28s ease-out both;
  }

  .brand-copy-reflection {
    clip-path: inset(0);
    animation: brand-reduced-glint .28s ease-out both;
  }
}

:root[data-motion="reduced"] .brand-block.is-sparkling .brand-mark {
  animation: none;
}

:root[data-motion="reduced"] .brand-ripple {
  display: none;
}

:root[data-motion="reduced"] .brand-block.is-sparkling::before {
  animation: brand-reduced-halo .28s ease-out both;
}

:root[data-motion="reduced"] .brand-copy-reflection {
  clip-path: inset(0);
  animation: brand-reduced-glint .28s ease-out both;
}

@keyframes brand-reduced-halo {
  0%, 100% { opacity: 0; }
  45% { opacity: .72; }
}

@keyframes brand-reduced-glint {
  0%, 100% { opacity: 0; }
  45% { opacity: .58; }
}
</style>
