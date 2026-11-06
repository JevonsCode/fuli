import 'vue-router'

// What the shell reads from a route's meta.
declare module 'vue-router' {
  interface RouteMeta {
    /** Catalog key (or plain text) for the shell's H1 and the browser title. */
    title?: string
    description?: string
    /** A page about one record (an Agent's profile): the H1 is its name alone,
     *  with no section tabs beside it; the page offers its own way back. */
    detail?: boolean
    /** The page keeps a sticky save bar at the bottom; floating tools stay off it. */
    saveBar?: boolean
    publicReport?: boolean
    /** The glossary term of the page's 「?」 in the top bar (features/ai-help): what it is for and 「让 AI 来做」. */
    aiHelp?: string
  }
}
