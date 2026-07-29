<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'

import { deleteJson, getJson, postJson } from '@/api/client'
import SearchableSelect from '@/components/SearchableSelect.vue'
import { compactIdentity, identitySearchText } from '@/lib/identity'
import { knowledgePath } from '@/router/paths'
import { useConsoleStore } from '@/stores/console'
import type { ProjectRelease, PublicProject } from '@/types'

type ProjectRelation = {
  id: string
  source_project_id: string
  target_project_id: string
  relation_type: string
  status?: string
}

const store = useConsoleStore()
const router = useRouter()
const selectedProject = ref<PublicProject | null>(null)
const releases = ref<ProjectRelease[]>([])
const relations = ref<ProjectRelation[]>([])
const detailLoading = ref(false)
const relationOpen = ref(false)
const relationSource = ref('')
const relationTarget = ref('')
const relationType = ref('RELATED_TO')

const projects = computed(() => store.state?.projects ?? [])
const subscribedKeys = computed(
  () => new Set(
    (store.state?.subscriptions ?? []).map(
      ({ provider_url, project_id }) => `${provider_url}::${project_id}`,
    ),
  ),
)
const maintainable = computed(() =>
  projects.value.filter(({ role, isOwner }) => role === 'maintainer' || isOwner),
)
const maintainableOptions = computed(() =>
  maintainable.value.map((project) => ({
    value: project.id,
    label: project.name,
    meta: `#${compactIdentity(project.id, 26)}`,
    search: identitySearchText(project.id),
  })),
)
const relationTargets = computed(() => {
  const source = projects.value.find(({ id }) => id === relationSource.value)
  return projects.value.filter(
    ({ id, providerUrl }) => id !== source?.id && providerUrl === source?.providerUrl,
  )
})
const relationTargetOptions = computed(() =>
  relationTargets.value.map((project) => ({
    value: project.id,
    label: project.name,
    meta: `#${compactIdentity(project.id, 26)}`,
    search: identitySearchText(project.id),
  })),
)
const relationTypeOptions = [
  { value: 'PART_OF', label: '属于' },
  { value: 'DEPENDS_ON', label: '依赖' },
  { value: 'PROVIDES_TO', label: '提供能力' },
  { value: 'SHARES_CAPABILITY_WITH', label: '共享能力' },
  { value: 'SUCCESSOR_OF', label: '后继于' },
  { value: 'RELATED_TO', label: '相关' },
]

function projectKey(project: PublicProject) {
  return `${project.providerUrl}::${project.id}`
}

function projectPurpose(project: PublicProject) {
  return project.profile?.purpose
    || project.profile?.scope
    || project.profile?.technical_summary
    || project.description
    || '公共项目'
}

async function toggleSubscription(project: PublicProject) {
  try {
    if (subscribedKeys.value.has(projectKey(project))) {
      const query = new URLSearchParams({
        personalSpaceId: store.activePersonalSpace?.id ?? '',
        providerUrl: project.providerUrl,
      })
      await deleteJson(`/api/subscriptions/${encodeURIComponent(project.id)}?${query}`)
      store.notify(`已取消订阅“${project.name}”；公共项目内容没有被删除。`)
    } else {
      await postJson('/api/subscriptions', {
        personalSpaceId: store.activePersonalSpace?.id,
        projectId: project.id,
        providerUrl: project.providerUrl,
        projectName: project.name,
      })
      store.notify(`已订阅“${project.name}”。`)
    }
    await store.refresh()
  } catch (error) {
    store.reportError(error)
  }
}

async function openDetails(project: PublicProject) {
  selectedProject.value = project
  releases.value = []
  relations.value = []
  detailLoading.value = true
  try {
    const provider = new URLSearchParams({ providerUrl: project.providerUrl })
    const [releaseResult, relationResult] = await Promise.all([
      getJson<{ releases?: ProjectRelease[] }>(
        `/api/projects/${encodeURIComponent(project.id)}/releases?${provider}`,
      ),
      getJson<{ relations?: ProjectRelation[] }>(
        `/api/project-relations?${new URLSearchParams({
          projectId: project.id,
          providerUrl: project.providerUrl,
        })}`,
      ),
    ])
    releases.value = releaseResult.releases ?? []
    relations.value = relationResult.relations ?? []
  } catch (error) {
    store.reportError(error)
  } finally {
    detailLoading.value = false
  }
}

async function openGraph(project: PublicProject) {
  selectedProject.value = null
  await router.push(knowledgePath('public', project.id, 'graph'))
}

async function deleteProject(project: PublicProject) {
  if (!window.confirm(`确认永久删除公共项目“${project.name}”？个人项目不会被删除。`)) return
  try {
    const query = new URLSearchParams({ providerUrl: project.providerUrl })
    await deleteJson(`/api/projects/${encodeURIComponent(project.id)}?${query}`)
    selectedProject.value = null
    store.notify(`公共项目“${project.name}”已删除；本机个人项目仍保留。`)
    await store.refresh()
  } catch (error) {
    store.reportError(error)
  }
}

async function createRelation() {
  const source = projects.value.find(({ id }) => id === relationSource.value)
  const target = projects.value.find(({ id }) => id === relationTarget.value)
  if (!source || !target) {
    store.reportError(new Error('请选择来源项目和关联项目'))
    return
  }
  try {
    await postJson('/api/project-relations', {
      sourceProjectId: source.id,
      targetProjectId: target.id,
      providerUrl: source.providerUrl,
      relationType: relationType.value,
      note: null,
    })
    relationOpen.value = false
    relationSource.value = ''
    relationTarget.value = ''
    store.notify(relationType.value === 'PART_OF' ? '关系已提交，等待父项目确认。' : '项目关系已建立。')
  } catch (error) {
    store.reportError(error)
  }
}

function formatDate(value?: string) {
  return value ? new Date(value).toLocaleString('zh-CN') : '时间未记录'
}
</script>

<template>
  <section class="view">
    <div class="space-heading public-space-heading">
      <span class="space-heading-icon" aria-hidden="true"><span class="nav-icon nav-icon-public-project" /></span>
      <div><p>浏览共享 Provider 上的项目，按需订阅。项目关系不会自动授予权限，也不会替你订阅。</p></div>
      <div class="public-space-stats" aria-label="公共项目概览">
        <span><strong>{{ projects.length }}</strong>可发现</span>
        <span><strong>{{ store.state?.subscriptions.length ?? 0 }}</strong>已订阅</span>
      </div>
    </div>

    <div class="project-grid">
      <article v-for="project in projects" :key="projectKey(project)" class="project-card">
        <div class="project-card-heading">
          <div><p class="eyebrow">PUBLIC PROJECT</p><h4>{{ project.name }}</h4></div>
          <div class="project-card-heading-actions">
            <button v-if="project.can_manage" class="management-action" type="button" @click="deleteProject(project)">管理项目</button>
            <div class="completion-badge">
              <strong>{{ project.profile?.assessment?.score ?? '—' }}</strong>
              <span>{{ project.profile?.assessment ? '资料覆盖' : '暂无摘要' }}</span>
            </div>
          </div>
        </div>
        <p class="project-purpose">{{ projectPurpose(project) }}</p>
        <div class="evidence-row">
          <span v-for="(source, index) in project.profile?.sources ?? []" :key="index" class="status-chip">{{ source.kind ?? '资料' }}</span>
          <span v-if="!project.profile?.sources?.length" class="muted">暂无已登记资料</span>
        </div>
        <div class="project-access">
          <span class="status-chip" :class="{ owner: project.isOwner }">{{ project.isOwner ? 'Owner' : project.role ?? 'Reader' }}</span>
          <span class="muted">{{ project.isOwner ? '你发布的项目' : '公共可发现' }}</span>
          <span v-if="project.current_release" class="project-release-meta">
            <strong>{{ project.current_release.version }}</strong>
            <span>{{ formatDate(project.current_release.published_at) }}</span>
          </span>
        </div>
        <footer class="project-card-footer">
          <button class="secondary-action" type="button" @click="toggleSubscription(project)">
            {{ subscribedKeys.has(projectKey(project)) ? '取消订阅' : '订阅项目' }}
          </button>
          <button class="primary-action" type="button" @click="openDetails(project)">查看详情</button>
        </footer>
      </article>
      <div v-if="!projects.length" class="empty-state project-empty">暂无公共项目</div>
    </div>

    <section class="project-section">
      <div class="section-toolbar compact-toolbar relation-section-toolbar">
        <div><p class="eyebrow">PROJECT RELATIONS</p><h3>项目关系</h3><p>只在同一个公共 Provider 内建立显式关系。</p></div>
        <button class="primary-action" type="button" :disabled="!maintainable.length" @click="relationOpen = !relationOpen">
          添加项目关系
        </button>
      </div>
      <form v-if="relationOpen" class="relation-composer relation-composer-form compact-relation-form" @submit.prevent="createRelation">
        <label>来源项目
          <SearchableSelect
            v-model="relationSource"
            :options="maintainableOptions"
            label="关系来源项目"
            placeholder="选择项目"
            searchable
            required
            @change="relationTarget = ''"
          />
        </label>
        <label>关系
          <SearchableSelect
            v-model="relationType"
            :options="relationTypeOptions"
            label="项目关系类型"
          />
        </label>
        <label>关联项目
          <SearchableSelect
            v-model="relationTarget"
            :options="relationTargetOptions"
            label="关系目标项目"
            placeholder="选择项目"
            searchable
            required
          />
        </label>
        <button class="primary-action" type="submit">添加关系</button>
      </form>
    </section>

    <dialog :open="Boolean(selectedProject)" class="project-dialog vue-dialog">
      <div v-if="selectedProject" class="project-dialog-shell">
        <header class="project-dialog-header">
          <div><p class="eyebrow">PUBLIC PROJECT</p><h3>{{ selectedProject.name }}</h3><p>{{ projectPurpose(selectedProject) }}</p></div>
          <button class="secondary-action" type="button" @click="selectedProject = null">关闭</button>
        </header>
        <section class="project-latest-release">
          <p class="eyebrow">LATEST RELEASE</p>
          <h4>最新发布</h4>
          <p v-if="selectedProject.current_release">
            <strong>{{ selectedProject.current_release.version }}</strong>
            · {{ formatDate(selectedProject.current_release.published_at) }}
          </p>
          <p v-else class="muted">这个项目还没有版本记录</p>
        </section>
        <div class="project-detail-columns">
          <section>
            <h4>版本记录</h4>
            <p v-if="detailLoading" class="muted">正在读取…</p>
            <article v-for="release in releases" :key="release.version" class="project-release-item">
              <strong>{{ release.version }}</strong><p>{{ release.update_summary }}</p><small>{{ formatDate(release.published_at) }}</small>
            </article>
            <p v-if="!detailLoading && !releases.length" class="muted">暂无版本记录</p>
          </section>
          <section>
            <h4>项目关系</h4>
            <article v-for="relation in relations" :key="relation.id" class="project-detail-relation">
              <strong>{{ relation.relation_type }}</strong><small>{{ relation.status ?? 'active' }}</small>
            </article>
            <p v-if="!detailLoading && !relations.length" class="muted">暂无项目关系</p>
          </section>
        </div>
        <footer class="project-dialog-actions">
          <span>项目内容与管理操作已分开。</span>
          <button class="primary-action" type="button" @click="openGraph(selectedProject)">查看知识图谱</button>
        </footer>
      </div>
    </dialog>
  </section>
</template>
