import type { RouteLocationNormalized } from 'vue-router'

// The shell's page widths (D-03, rec#38): the wide work canvas for content
// that is wide by nature (boards, tables, graphs, tile collections), a
// readable centred column for single-column content pages, and the narrower
// form column. A page reads its width as --layout-max, which the shell sets
// from this value, so no page picks its own.
export type PageLayout = 'canvas' | 'column' | 'form'
type LayoutRoute = Pick<RouteLocationNormalized, 'meta' | 'params'>
export type PageLayoutRule = PageLayout | ((route: LayoutRoute) => PageLayout)

export function pageLayout(route: LayoutRoute): PageLayout | undefined {
  const rule = route.meta.layout
  return typeof rule === 'function' ? rule(route) : rule
}
