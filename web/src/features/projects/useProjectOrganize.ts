import { computed, ref, type Ref } from 'vue'

import { apiErrorCode, apiErrorReason, postJson } from '@/api/client'
import type { ProjectDragEvent } from '@/features/knowledge/graph-runtime'
import { t } from '@/i18n'
import type { KnowledgeGraph } from '@/types'
import {
  dropTargetAt,
  projectForNode,
  projectName,
  projectTree,
  resolveProjectDrop,
  type OrganizeProject,
  type ProjectDropRefusal,
  type ProjectDropTarget,
} from './project-organize'

interface OrganizeCanvas {
  markDropTarget(nodeId: string | null): void
  restoreNode(nodeId: string): void
}

const REFUSAL_REASONS: Record<string, 'cycle' | 'self' | 'changed' | 'notFound'> = {
  project_hierarchy_cycle: 'cycle',
  project_hierarchy_self: 'self',
  project_hierarchy_changed: 'changed',
  project_not_found: 'notFound',
  parent_not_found: 'notFound',
}

// 调整层级 on the projects graph: the person drags a project onto another one,
// or onto the drop panel, and the move is saved as the new parent.
export function useProjectOrganize({ graph, spaceId, canvas, onMoved }: {
  graph: Ref<KnowledgeGraph | null>
  spaceId: Ref<string>
  canvas: Ref<OrganizeCanvas | null>
  onMoved(): Promise<void>
}) {
  const enabled = ref(false)
  const dragging = ref<OrganizeProject | null>(null)
  const hovered = ref<ProjectDropTarget | null>(null)
  const pendingLabel = ref('')
  const failure = ref('')
  const tree = computed(() => projectTree(graph.value))

  function onProjectDrag(event: ProjectDragEvent) {
    const project = projectForNode(tree.value, event.node.id)
    if (!project) return
    if (pendingLabel.value) {
      if (event.phase === 'end') canvas.value?.restoreNode(project.nodeId)
      return
    }
    if (event.phase === 'start') {
      dragging.value = project
      hovered.value = null
      failure.value = ''
      return
    }
    const target = targetAt(event)
    if (event.phase === 'move') {
      // Only a target that accepts the drop grows and changes colour.
      const accepting = target && 'move' in resolveProjectDrop(tree.value, project.projectId, target) ? target : null
      hovered.value = accepting
      canvas.value?.markDropTarget(accepting?.kind === 'under'
        ? tree.value.projects.find(({ projectId }) => projectId === accepting.projectId)?.nodeId ?? null
        : null)
      return
    }
    dragging.value = null
    hovered.value = null
    canvas.value?.markDropTarget(null)
    void drop(project, target)
  }

  // A panel target under the pointer wins; otherwise the project node under
  // the dragged one.
  function targetAt(event: ProjectDragEvent): ProjectDropTarget | null {
    const element = typeof document.elementFromPoint === 'function'
      ? document.elementFromPoint(event.clientX, event.clientY)
      : null
    const panelTarget = dropTargetAt(element)
    if (panelTarget) return panelTarget
    const over = event.over ? projectForNode(tree.value, event.over.id) : null
    return over ? { kind: 'under', projectId: over.projectId } : null
  }

  async function drop(project: OrganizeProject, target: ProjectDropTarget | null) {
    const outcome = target
      ? resolveProjectDrop(tree.value, project.projectId, target)
      : { refusal: 'unchanged' as const }
    if ('refusal' in outcome) {
      canvas.value?.restoreNode(project.nodeId)
      if (outcome.refusal !== 'unchanged') failure.value = failed(project, outcome.refusal, target)
      return
    }
    const { parentProjectId } = outcome.move
    pendingLabel.value = parentProjectId
      ? t('projects.organize.movingUnder', { name: project.name, parent: projectName(tree.value, parentProjectId) })
      : t('projects.organize.movingTop', { name: project.name })
    try {
      await postJson(`/api/personal-projects/${encodeURIComponent(project.projectId)}/parent`, {
        personalSpaceId: spaceId.value,
        parentProjectId,
      })
      await onMoved()
    } catch (error) {
      canvas.value?.restoreNode(project.nodeId)
      const reason = REFUSAL_REASONS[apiErrorCode(error) ?? '']
      failure.value = t('projects.organize.failed', {
        name: project.name,
        reason: reason
          ? reasonText(reason, project, parentProjectId)
          : apiErrorReason(error),
      })
    } finally {
      pendingLabel.value = ''
    }
  }

  function failed(project: OrganizeProject, refusal: Exclude<ProjectDropRefusal, 'unchanged'>,
    target: ProjectDropTarget | null) {
    const parent = target?.kind === 'under' ? target.projectId : null
    return t('projects.organize.failed', { name: project.name, reason: reasonText(refusal, project, parent) })
  }

  function reasonText(reason: 'cycle' | 'self' | 'changed' | 'notFound', project: OrganizeProject,
    parentProjectId: string | null) {
    return t(`projects.organize.reasons.${reason}`, {
      name: project.name,
      parent: projectName(tree.value, parentProjectId),
    })
  }

  function setEnabled(value: boolean) {
    enabled.value = value
    failure.value = ''
  }

  return { enabled, setEnabled, dragging, hovered, pendingLabel, failure, tree, onProjectDrag }
}
