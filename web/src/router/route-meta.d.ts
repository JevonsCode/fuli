import 'vue-router'

// What the shell reads from a route's meta.
declare module 'vue-router' {
  interface RouteMeta {
    /** Catalog key (or plain text) for the shell's H1 and the browser title. */
    title?: string
    description?: string
    /** Rebuilt pages: one centred work canvas, or the narrower form column. */
    layout?: 'canvas' | 'form'
    dedicatedWorkspace?: boolean
    publicReport?: boolean
  }
}
