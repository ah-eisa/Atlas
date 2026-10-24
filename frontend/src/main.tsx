import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

// Self-hosted fonts, bundled by Vite - no external font requests at runtime.
// Only the weights the design system actually uses are imported.
// Plus Jakarta Sans: the interface.
import '@fontsource/plus-jakarta-sans/400.css'
import '@fontsource/plus-jakarta-sans/500.css'
import '@fontsource/plus-jakarta-sans/600.css'
import '@fontsource/plus-jakarta-sans/700.css'
// Cormorant Garamond: headlines and the large figures that lead a view.
import '@fontsource/cormorant-garamond/500.css'
import '@fontsource/cormorant-garamond/600.css'
import '@fontsource/cormorant-garamond/700.css'
// JetBrains Mono: every figure, with tabular numerals, plus code and raw CSV.
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/jetbrains-mono/600.css'

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
