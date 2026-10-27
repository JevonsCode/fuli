import type { RouteLocationNormalized } from 'vue-router'

// What kind of page a route is: a work canvas (boards, tables, graphs, tile
// collections), a single-column content page, or a form. Every kind is
// centred at the same page width (--canvas-max, Jevons 10-27) and the top bar
// keeps it; a form's content reads at --form-measure inside it, so fields and
// settings rows never stretch across a wide screen. A page reads its content
// width as --layout-max, which the shell sets, so no page picks its own.
export type PageLayout = 'canvas' | 'column' | 'form'
type LayoutRoute = Pick<RouteLocationNormalized, 'meta' | 'params'>
export type PageLayoutRule = PageLayout | ((route: LayoutRoute) => PageLayout)

export function pageLayout(route: LayoutRoute): PageLayout | undefined {
  const rule = route.meta.layout
  return typeof rule === 'function' ? rule(route) : rule
}
