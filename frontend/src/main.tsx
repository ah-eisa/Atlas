import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

// Self-hosted fonts, bundled by Vite - no external font requests at runtime.
// Only the weights the design system actually uses are imported.
// Instrument Sans: the interface and every small figure.
import '@fontsource/instrument-sans/400.css'
import '@fontsource/instrument-sans/500.css'
import '@fontsource/instrument-sans/600.css'
// Newsreader: headlines and the large figures that lead a view.
import '@fontsource/newsreader/400.css'
import '@fontsource/newsreader/500.css'
// IBM Plex Mono: code, file names and raw CSV only.
import '@fontsource/ibm-plex-mono/400.css'

import './styles/tokens.css'
import './styles/base.css'
import './styles/layout.css'
import './styles/panels.css'
import './styles/forms.css'
import './styles/dialog.css'
import './styles/navigation.css'
import './styles/views.css'

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
