<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { postJson } from '@/api/client'
import { useConsoleStore } from '@/stores/console'
import type { PersonalProject } from '@/types'

const props = defineProps<{
  project: PersonalProject | null
}>()

const emit = defineEmits<{
  close: []
  published: []
}>()

const store = useConsoleStore()
const version = ref('')
const summary = ref('')
const error = ref('')
const busy = ref(false)

const publicProject = computed(() =>
  store.state?.projects.find(
    ({ publication_key }) => publication_key && publication_key === props.project?.publication_key,
  ) ?? null,
)
const currentVersion = computed(() => publicProject.value?.current_release?.version ?? null)
const providerUrl = computed(
  () => store.state?.providers?.workspaces?.find(({ status }) => status === 'ready')?.providerUrl ?? null,
)

watch(
  () => props.project,
  (project) => {
    if (!project) return
    version.value = suggestedVersion(currentVersion.value)
    summary.value = ''
    error.value = ''
  },
)

async function publish() {
  if (!props.project) return
  if (!providerUrl.value) {
    error.value = '公共 Provider 当前不可用'
    return
  }
  if (!version.value.trim()) {
    error.value = '请填写发布版本'
    return
  }
  if (!summary.value.trim()) {
    error.value = '请填写本次更新内容'
    return
  }
  busy.value = true
  error.value = ''
  try {
    await postJson('/api/projects/publish', {
      personalSpaceId: store.activePersonalSpace?.id,
      localProjectId: props.project.project_id,
      providerUrl: providerUrl.value,
      releaseVersion: version.value.trim(),
      updateSummary: summary.value.trim(),
    })
    store.notify(`“${props.project.profile.name}” ${version.value.trim()} 已发布并记录版本信息。`)
    await store.refresh()
    emit('close')
    emit('published')
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '发布失败'
    store.reportError(cause)
  } finally {
    busy.value = false
  }
}

function suggestedVersion(current: string | null) {
  if (!current || current === 'legacy') return 'v1.0.0'
  const match = current.match(/^(v?)(\d+)\.(\d+)\.(\d+)$/)
  if (!match) return ''
  return `${match[1]}${match[2]}.${match[3]}.${Number(match[4]) + 1}`
}
</script>

<template>
  <dialog v-if="project" open class="publish-dialog vue-dialog">
    <div class="publish-dialog-shell">
      <p class="eyebrow">PUBLICATION</p>
      <h3>发布到公共空间？</h3>
      <p class="publish-dialog-intro">
        <strong>{{ project.profile.name }}</strong>
        <span>发布后会进入共享 Provider，不再只是本机可见。</span>
      </p>
      <div class="publish-release-fields">
        <label><span>发布版本</span><input v-model="version" maxlength="64" placeholder="例如 v1.0.0" /><small>{{ currentVersion ? `当前版本 ${currentVersion}` : '首次发布' }}</small></label>
        <label><span>更新内容</span><textarea v-model="summary" maxlength="4096" rows="4" placeholder="说明本次新增、调整或修复了什么" /></label>
      </div>
      <div class="publish-impact" aria-label="发布影响">
        <div><strong>公开可发现</strong><span>连接这个公共服务的用户可以看到该项目。</span></div>
        <div><strong>你成为 Owner</strong><span>系统会自动订阅项目，你可以继续维护项目资料。</span></div>
        <div><strong>同步项目档案</strong><span>项目说明、资料摘要和已登记资料会复制到公共项目。</span></div>
      </div>
      <p v-if="error" class="publish-dialog-error" role="alert">{{ error }}</p>
      <div class="publish-dialog-actions">
        <button class="secondary-action" type="button" :disabled="busy" @click="emit('close')">取消</button>
        <button class="primary-action" type="button" :disabled="busy" @click="publish">{{ busy ? '正在发布…' : '确认发布' }}</button>
      </div>
    </div>
  </dialog>
</template>
