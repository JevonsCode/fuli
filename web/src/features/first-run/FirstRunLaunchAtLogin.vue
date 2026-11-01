<script setup lang="ts">
import { onMounted, ref } from 'vue'

import GrowthLoading from '@/components/GrowthLoading.vue'
import { Switch } from '@/components/ui/switch'
import { t } from '@/i18n'
import { readLaunchAtLogin, saveLaunchAtLogin } from '@/lib/desktop-client'
import UiNotice from '@/ui/UiNotice.vue'

// The guide's start-at-login step: the Windows desktop client's own setting
// (its tray menu's 「开机时启动」), on unless the person turned it off. Not
// shown in a browser, on macOS, or where the client does not offer it.
const enabled = ref<boolean | null>(null)
const saving = ref(false)
const failed = ref(false)

async function change(value: boolean) {
  if (saving.value) return
  saving.value = true
  failed.value = false
  const saved = await saveLaunchAtLogin(value)
  failed.value = saved !== value
  if (saved !== null) enabled.value = saved
  saving.value = false
}

onMounted(async () => { enabled.value = await readLaunchAtLogin() })
</script>

<template>
  <section v-if="enabled !== null" class="first-run-step" aria-labelledby="first-run-login-title" data-first-run-login>
    <h3 id="first-run-login-title" class="ui-group-label">{{ t('firstRun.login.title') }}</h3>
    <label class="first-run-login">
      <span class="first-run-login__text">
        <span class="first-run-login__name">{{ t('firstRun.login.label') }}</span>
        <GrowthLoading v-if="saving" variant="inline" :label="t(enabled ? 'firstRun.login.turningOff' : 'firstRun.login.turningOn')" />
        <small v-else>{{ t('firstRun.login.hint') }}</small>
      </span>
      <Switch :model-value="enabled" :disabled="saving" :aria-label="t('firstRun.login.label')" data-first-run-login-switch
        @update:model-value="value => change(value === true)" />
    </label>
    <UiNotice v-if="failed" tone="error">{{ t('firstRun.login.failed') }}</UiNotice>
  </section>
</template>

<style scoped>
.first-run-login { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 36px; cursor: pointer; user-select: none; }
.first-run-login__text { display: grid; gap: 2px; min-width: 0; }
.first-run-login__name { color: var(--color-ink); font-size: var(--text-body); font-weight: var(--weight-medium); }
.first-run-login small { min-height: 1.5em; color: var(--color-muted); font-size: var(--text-meta); }
</style>
