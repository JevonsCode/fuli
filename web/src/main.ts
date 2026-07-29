import * as d3 from 'd3'
import { createPinia } from 'pinia'
import { createApp } from 'vue'

import App from './App.vue'
import { router } from './router'
import '../styles.css'
import './styles/vue.css'

;(globalThis as typeof globalThis & { d3: typeof d3 }).d3 = d3

const app = createApp(App)
app.use(createPinia())
app.use(router)

await router.isReady()
app.mount('#app')
