import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import pageStyles from '../../../styles.css?raw'
import primitives from '@/styles/primitives.css?raw'
import { findTerm } from '@/features/glossary/terms'
import KnowledgeDirectoryPanel from './KnowledgeDirectoryPanel.vue'

const rule = (css: string, selector: string) => {
  const start = css.indexOf(`${selector} {`)
  if (start < 0) throw new Error(`missing ${selector}`)
  return css.slice(start, css.indexOf('}', start))
}

describe('KnowledgeDirectoryPanel', () => {
  it('counts the content only in its validity chips, with no bare count beside them', () => {
    const wrapper = mount(KnowledgeDirectoryPanel, {
      props: {
        personalProjectsOnly: false, directorySection: 'knowledge', knowledgeTabCount: '', materialTabCount: '',
        contentStatus: 'current', currentItemCount: 44, historicalItemCount: 0, allItems: [], visibleItems: [],
        projectMaterialItems: [], visibleProjectMaterialItems: [], selectedItem: null, listResetKey: 0, sourceLabel: () => '',
      },
    })
    const heading = wrapper.get('.directory-section-heading')
    expect(heading.text()).toContain('当前有效')
    expect(heading.text()).not.toMatch(/\d+\s*条/)
    // 「?」 mode explains each validity chip.
    expect(['current', 'historical', 'all'].map(key => findTerm(heading.get(`[data-stat="${key}"]`).element)?.term.id))
      .toEqual(['memory.current', 'memory.history', 'memory.all'])
  })

  it('sets the toolbar, filters and table apart with spacing instead of divider lines', () => {
    expect(rule(pageStyles, '.graph-view-actions')).not.toMatch(/border/)
    expect(rule(pageStyles, '.knowledge-layout')).not.toMatch(/border:/)
    expect(rule(pageStyles, '.directory-section-heading')).not.toMatch(/border/)
    expect(rule(primitives, '.ui-disclosure')).not.toMatch(/border/)
    // The tabs keep their underline.
    expect(rule(pageStyles, '.directory-kind-tabs')).toMatch(/border-bottom/)
  })
})
