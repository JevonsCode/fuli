import { createPinia } from 'pinia'
import { createApp } from 'vue'

import App from './App.vue'
import { i18n } from './i18n'
import { router } from './router'
import '../styles.css'
import './styles/connections.css'
import './styles/knowledge-graph.css'
import './styles/vue.css'

const app = createApp(App)
app.use(createPinia())
app.use(i18n)
app.use(router)

await router.isReady()
app.mount('#app')
