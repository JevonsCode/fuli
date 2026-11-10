// The quick-start guide's script entry.
import { startGuidePage } from './guide-page.js'
import { startGuideTours } from './guide-tour.js'
import * as catalog from './guide/translations.js'

startGuidePage(catalog)
startGuideTours({ document, window })
