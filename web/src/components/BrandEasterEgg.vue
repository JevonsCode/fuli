<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'

import fuliLogoUrl from '../../assets/brand/fuli-logo.png'
import { getJson } from '@/api/client'
import { t } from '@/i18n'
import { FULI_VERSION } from '@/version'

interface PackageVersionStatus {
  status: 'ready' | 'unavailable'
  currentVersion: string
  latestVersion: string | null
  updateAvailable: boolean
  packageUrl: string
  checkedAt: string
}

const root = ref<HTMLElement | null>(null)
const versionButton = ref<HTMLButtonElement | null>(null)
const effectRun = ref(0)
const isPlaying = ref(false)
const isKeyboardFocused = ref(false)
const isUpdateOpen = ref(false)
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

function playEffect() {
  effectRun.value += 1
  isPlaying.value = true
}

function finishEffect() {
  isPlaying.value = false
}

function toggleUpdateDetails() {
  if (updateAvailable.value) isUpdateOpen.value = !isUpdateOpen.value
}

function handleGlobalPointerDown(event: PointerEvent) {
  lastInputWasKeyboard = false
  isKeyboardFocused.value = false
  if (isUpdateOpen.value && !root.value?.contains(event.target as Node)) {
    isUpdateOpen.value = false
  }
}

function handleGlobalKeyDown(event: KeyboardEvent) {
  if (event.key === 'Tab') lastInputWasKeyboard = true
  if (event.key === 'Escape' && isUpdateOpen.value) {
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
          <span :key="`orbit-${effectRun}`" class="brand-orbit" aria-hidden="true" />
        </template>
      </span>
    </button>

    <span class="brand-copy">
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
      <p>{{ t('console.update.copy') }}</p>
      <code>fuli update --yes</code>
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
  background: radial-gradient(circle, rgba(244, 201, 112, .2), rgba(244, 201, 112, 0) 68%);
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
  box-shadow: 0 0 0 2px #789084;
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

.brand-orbit {
  position: absolute;
  z-index: 3;
  inset: -8px;
  border-radius: 50%;
  opacity: 0;
  pointer-events: none;
  animation: brand-orbit-travel .94s cubic-bezier(.2, .7, .22, 1) both;
}

.brand-orbit::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: conic-gradient(
    from 20deg,
    transparent 0 74%,
    rgba(230, 177, 74, 0) 79%,
    rgba(230, 177, 74, .24) 87%,
    rgba(255, 244, 211, .78) 96%,
    transparent 100%
  );
  -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 1.5px));
  mask: radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 1.5px));
}

.brand-orbit::after {
  content: '';
  position: absolute;
  top: -2px;
  left: 50%;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: radial-gradient(circle at 34% 30%, #fff 0 14%, #fff1c7 30%, #e8b653 58%, rgba(232, 182, 83, 0) 74%);
  box-shadow: 0 0 6px rgba(244, 198, 104, .78), 0 0 14px rgba(244, 198, 104, .32);
  transform: translateX(-50%);
}

.brand-copy {
  position: relative;
  display: grid;
  min-width: 0;
}

.brand-title-row {
  display: flex;
  align-items: baseline;
  gap: 7px;
}

.brand-name {
  font-size: 18px;
  font-weight: 700;
  letter-spacing: -.02em;
}

.brand-version {
  color: #8a928c;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 9px;
  font-weight: 600;
  letter-spacing: .02em;
  white-space: nowrap;
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
  color: #555e57;
}

.brand-version-button:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px #789084;
}

.brand-update-dot {
  width: 5px;
  height: 5px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: #d53d3d;
  box-shadow: 0 1px 4px rgba(189, 30, 30, .28);
}

.brand-subtitle {
  margin-top: 2px;
  color: #747d76;
  font-size: 10px;
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
  color: #c89536;
  text-shadow: 0 0 6px rgba(239, 190, 93, .28);
}

.brand-update-popover {
  position: absolute;
  z-index: 20;
  top: 45px;
  right: 8px;
  left: 49px;
  padding: 12px;
  border-radius: 12px;
  color: #263129;
  background: #fff;
  box-shadow: 0 10px 28px rgba(35, 48, 39, .16);
}

.brand-update-popover strong {
  display: block;
  font-size: 11px;
  line-height: 1.45;
}

.brand-update-popover p {
  margin: 5px 0 9px;
  color: #5a665e;
  font-size: 10px;
  line-height: 1.5;
}

.brand-update-popover code {
  display: block;
  padding: 7px 8px;
  border-radius: 7px;
  color: #27342b;
  background: #f1f4f1;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 9px;
  line-height: 1.45;
  overflow-wrap: anywhere;
  user-select: all;
}

.brand-update-popover a {
  display: inline-block;
  margin-top: 9px;
  color: #356c55;
  font-size: 10px;
  font-weight: 650;
  text-decoration-thickness: 1px;
  text-underline-offset: 2px;
}

.brand-update-popover a:hover {
  color: #234d3b;
}

.brand-update-popover a:focus-visible {
  outline: 2px solid #789084;
  outline-offset: 3px;
  border-radius: 2px;
}

.brand-block.is-sparkling::before {
  animation: brand-halo 1.05s ease-out both;
}

@keyframes brand-orbit-travel {
  0% { opacity: 0; transform: rotate(-132deg) scale(.94); }
  18% { opacity: 0; }
  32% { opacity: 1; }
  72% { opacity: .9; }
  100% { opacity: 0; transform: rotate(80deg) scale(1.01); }
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
  .brand-orbit {
    display: none;
  }

  .brand-block.is-sparkling::before {
    animation: brand-reduced-halo .28s ease-out both;
  }

  .brand-copy-reflection {
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
}
</style>
