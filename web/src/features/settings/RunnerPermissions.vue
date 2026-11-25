<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { getJson, postJson } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { t } from '@/i18n'

import { grantsShape, grantShape, requestProblem, type Grants } from './runner-ownership-model'

const props = defineProps<{ fingerprint: string, scopes: string[] }>()
const path = computed(() => '/api/runners/' + encodeURIComponent(props.fingerprint) + '/grants')
const data = ref<Grants | null>(null), selected = ref('global'), busy = ref(false), error = ref('')
let revision = 0
async function load() {
  const id = ++revision
  data.value = null
  error.value = ''
  try {
    const result = await getJson(path.value, grantsShape)
    if (id === revision) data.value = result
  } catch (e) { if (id === revision) error.value = requestProblem(e) }
}
watch(() => props.fingerprint, load, { immediate: true })
async function decide(scope: string, state: 'allowed' | 'revoked') {
  if (!data.value || busy.value) return
  const grant = data.value.scopes.find(item => item.scope === scope)
  const endpoint = path.value
  busy.value = true
  error.value = ''
  try {
    await postJson(endpoint, { scope, state, version: grant?.version ?? 0, pairing: data.value.pairing }, grantShape)
    if (endpoint === path.value) await load()
  } catch (e) { if (endpoint === path.value) error.value = requestProblem(e) }
  finally { busy.value = false }
}
const scopeName = (scope: string) => scope === '*' ? t('ownership.all') : scope === 'global' ? t('ownership.global') : scope.slice(8)
</script>
<template>
  <section class="runner-permissions">
    <GrowthLoading v-if="!data && !error" variant="compact" :label="t('ownership.loadingGrant')" />
    <GrowthLoading v-if="busy" variant="compact" :label="t('ownership.saving')" />
    <div v-for="row in data?.scopes" :key="row.scope" class="runner-permission-row">
      <span>{{ scopeName(row.scope) }} · {{ t('ownership.' + row.state) }}</span>
      <Button v-if="row.scope !== '*' && row.state !== 'allowed' && scopes.includes(row.scope)" type="button" size="sm" :disabled="busy" @click="decide(row.scope, 'allowed')">{{ t('ownership.allow') }}</Button>
      <Button v-if="row.scope !== '*' && row.state !== 'revoked'" type="button" size="sm" variant="outline" :disabled="busy" @click="decide(row.scope, 'revoked')">{{ t('ownership.revoke') }}</Button>
    </div>
    <div v-if="data" class="runner-permission-row">
      <label>{{ t('ownership.additional') }} <select v-model="selected"><option v-for="scope in scopes" :key="scope" :value="scope">{{ scopeName(scope) }}</option></select></label>
      <Button type="button" size="sm" :disabled="busy" @click="decide(selected, 'allowed')">{{ t('ownership.allow') }}</Button>
      <Button type="button" size="sm" variant="outline" :disabled="busy" @click="decide(selected, 'revoked')">{{ t('ownership.revoke') }}</Button>
    </div>
    <p v-if="error" role="alert">{{ error }}</p>
  </section>
</template>
<style scoped>
.runner-permissions { display: grid; gap: 10px; }
.runner-permission-row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
</style>
