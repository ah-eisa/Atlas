import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

// Self-hosted IBM Plex, bundled by Vite - no external font requests at runtime.
// Only the weights the design system actually uses are imported.
import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'

import './styles/tokens.css'
import './styles/base.css'
import './styles/layout.css'
import './styles/panels.css'
import './styles/forms.css'

import App from './App'
import { applyTheme, getTheme, watchSystemTheme } from './lib/theme'

// The inline script in index.html already set the theme before the first
// paint; this keeps the document in step with the module's own state, and
// follows the operating system until the user picks a theme explicitly.
applyTheme(getTheme())
watchSystemTheme()

const container = document.getElementById('root')
if (!container) throw new Error('#root not found in index.html')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
